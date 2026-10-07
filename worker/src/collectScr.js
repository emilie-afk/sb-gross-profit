/**
 * collectScr.js — Shipping Cost Report versions at ship-date level (Free-tier path)
 * ================================================================================
 * POST /v1/collect/scr/owners              { from, to } → { owners: [[date, dayHash]] }            (ingest)
 * POST /v1/collect/scr/versions            { sourceId, requestedFrom, requestedTo, exportedAt, days: [[date, groups] | [date, null, dayHash]] }
 *                                          A date identical to its current owner may be sent as its hash alone
 *                                          (checked against the owner and the validated segment sums), so the
 *                                          request's work grows with the CHANGED dates, not the window.
 * POST /v1/collect/scr/days                { keys: [[versionId, date]] } → groups   (ingest or verify)
 * GET  /v1/admin/scr/versions              list (codes and counts only)
 * GET  /v1/admin/scr/versions/:id          one version: per-date outcomes; held dates with per-order before/after (admin only)
 * POST /v1/admin/scr/versions/:id/accept   { reason }  activate everything the version still holds for review
 * POST /v1/admin/scr/versions/:id/reject   { reason }  pending version: reject it whole · partially accepted
 *                                          version: reject its held dates, keep the dates already accepted
 * POST /v1/admin/scr/activations/:id/rollback { reason }   undo the LATEST activation exactly
 * Every admin decision is recorded in scr_decision (who, when, reason, dates, affected weeks).
 *
 * The collector sends the per-(date, order) groups it built with the unchanged
 * parser from a RETAINED sanitized report (collectSources.js). The Worker checks
 * them against the per-date sums its own segment validation recorded, then
 * applies the owner-approved rules (shared/scrDays.js):
 *   review (nothing activated)  first version, coverage gap, possibly incomplete trailing
 *                               date, $0.00 or over-cap Shipping Cost, non-zero
 *                               insurance / duties / taxes / import fee, non-midnight
 *                               ship time, unexpected store
 *   per date                    new → activated · identical → no-op · fill-in (only orders
 *                               with no accepted cost) → activated, affected weeks get an
 *                               unpublished draft revision · changed / removed accepted
 *                               cost → held for review
 *   auto-acceptance switch      `shipping_cost_auto_accept_enabled` (default false). While
 *                               false, a version that would activate or hold any date goes
 *                               to review whole (`auto_acceptance_disabled`); only an
 *                               identical re-export (nothing to activate) is a no-op.
 * `shipping_cost_report_source_verified` is untouched: activation feeds drafts only.
 */
import { ApiError, json, readJson } from './http.js';
import { newId, nowIso, getSettings, selectIn, atomic } from './db.js';
import { actorFor } from './actor.js';
import { addDays, weekStartOf } from '../../shared/normalized.js';
import { dayHash, classifyDay, versionReviewReasons, autoDecision, mergePreserved } from '../../shared/scrDays.js';
import { weekWindowUtc } from '../../shared/schedule.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KEY = /^\d{4,10}$/;
const P = (s, d = null) => { try { return JSON.parse(s); } catch { return d; } };
const MAX_DAYS = 120;

async function owners(db, from, to) {
  const r = (await db.prepare('SELECT ship_date, version_id, day_hash FROM scr_day_owner WHERE ship_date BETWEEN ?1 AND ?2').bind(from, to).all()).results || [];
  return new Map(r.map(x => [x.ship_date, { versionId: x.version_id, dayHash: x.day_hash }]));
}
async function coverage(db) {
  const c = await db.prepare('SELECT MIN(ship_date) AS f, MAX(ship_date) AS t, COUNT(*) AS n FROM scr_day_owner').first();
  return c?.n ? { from: c.f, to: c.t } : null;
}
async function dayGroupsOf(db, pairs) {
  if (!pairs.length) return new Map();
  const rows = await selectIn(db, `SELECT d.version_id, d.ship_date, d.groups FROM scr_day d
      JOIN json_each(?1) j ON d.version_id = json_extract(j.value, '$[0]') AND d.ship_date = json_extract(j.value, '$[1]')`, pairs);
  return new Map(rows.map(r => [`${r.version_id}|${r.ship_date}`, P(r.groups, [])]));
}
/** Order keys ?1 with cost on some currently owned date: an indexed lookup (scr_day_key, migration 0020). */
export const ACCEPTED_KEYS_SQL = `SELECT DISTINCT k.order_key AS k FROM scr_day_key k
    JOIN scr_day_owner o ON o.ship_date = k.ship_date AND o.version_id = k.version_id
    WHERE k.order_key IN (SELECT value FROM json_each(?1))`;
/** Which of these order keys already have accepted cost on some owned date (evaluated in D1, not Worker CPU). */
async function keysWithAcceptedCost(db, keys) {
  if (!keys.length) return new Set();
  const rows = await selectIn(db, ACCEPTED_KEYS_SQL, keys);
  return new Set(rows.map(r => String(r.k)));
}
/** Weeks whose orders' shipping costs move when these dates change owner (order weeks + ship weeks). */
async function affectedWeeks(db, days) {
  const keys = [...new Set(days.flatMap(d => d.groups.map(g => g[0])))];
  const weeks = new Set(days.map(d => weekStartOf(d.date)));
  if (keys.length) for (const r of await selectIn(db, 'SELECT DISTINCT week_start FROM ord_ptr WHERE order_number IN (SELECT value FROM json_each(?1))', keys)) weeks.add(r.week_start);
  return [...weeks].sort();
}

function checkDays(b, summary) {
  if (!Array.isArray(b.days)) throw new ApiError(400, 'bad_payload', 'days must be [[date, groups], …]');
  const want = []; for (let d = b.requestedFrom; d <= b.requestedTo; d = addDays(d, 1)) want.push(d);
  if (want.length > MAX_DAYS) throw new ApiError(400, 'bad_payload', `At most ${MAX_DAYS} days per version`);
  if (b.days.length !== want.length || b.days.some((x, i) => !Array.isArray(x) || x[0] !== want[i])) throw new ApiError(400, 'bad_payload', 'days must list every date of the requested range once, in order');
  for (const [date, groups, hash] of b.days) {
    if (groups === null) { if (!/^[0-9a-f]{64}$/.test(hash || '')) throw new ApiError(400, 'bad_payload', 'A date without groups needs its day hash'); continue; }
    if (!Array.isArray(groups)) throw new ApiError(400, 'bad_payload', 'groups must be an array');
    let prev = '', cents = 0, rows = 0;
    for (const g of groups) {
      if (!Array.isArray(g) || g.length !== 3 || !KEY.test(g[0]) || !Number.isInteger(g[1]) || g[1] < 0 || !Number.isInteger(g[2]) || g[2] < 1) throw new ApiError(400, 'bad_payload', 'Each group is [orderKey, costCents, rowCount]');
      if (g[0] <= prev) throw new ApiError(400, 'bad_payload', 'groups must be sorted by order key, one per order');
      prev = g[0]; cents += g[1]; rows += g[2];
    }
    const seg = summary.perDate[date] || [0, 0];
    if (seg[0] !== cents || seg[1] !== rows) throw new ApiError(400, 'groups_mismatch', 'The groups do not reconcile with the validated segments for a date');
  }
}

export async function uploadScrVersion(request, env) {
  const b = await readJson(request);
  const db = env.DB;
  if (!DATE.test(b.requestedFrom || '') || !DATE.test(b.requestedTo || '') || b.requestedFrom > b.requestedTo) throw new ApiError(400, 'bad_payload', 'requestedFrom / requestedTo must be YYYY-MM-DD');
  const src = await db.prepare("SELECT * FROM src_object WHERE source_id = ?1 AND kind = 'shipping_cost_report'").bind(String(b.sourceId || '')).first();
  if (!src) throw new ApiError(404, 'source_unknown', 'No such Shipping Cost Report source');
  if (src.status !== 'retained') throw new ApiError(409, 'source_not_retained', 'The source is not sealed and retained');
  const declared = P(src.declared, {}), summary = P(src.summary, {});
  if (declared.window.from !== b.requestedFrom || declared.window.to !== b.requestedTo) throw new ApiError(400, 'bad_payload', 'The requested range must equal the source window');
  const again = await db.prepare('SELECT version_id, status, outcome FROM scr_version WHERE source_id = ?1').bind(src.source_id).first();
  if (again) return json({ versionId: again.version_id, status: again.status, ...P(again.outcome, {}), duplicate: true });
  checkDays(b, summary);

  const s = await getSettings(db);
  const own = await owners(db, b.requestedFrom, b.requestedTo);
  // Dates sent as a hash alone must be identical to their current owner, whose stored sums must
  // equal the sums this source's validated segments recorded for the date.
  const hashOnly = b.days.filter(x => x[1] === null);
  if (hashOnly.length) {
    if (hashOnly.some(([date, , hash]) => own.get(date)?.dayHash !== hash)) throw new ApiError(409, 'day_hash_unknown', 'A date sent as a hash is not identical to its current owner; send its groups');
    const sums = new Map(((await selectIn(db, `SELECT d.ship_date, d.cost_cents, d.row_count FROM scr_day d
        JOIN json_each(?1) j ON d.version_id = json_extract(j.value, '$[0]') AND d.ship_date = json_extract(j.value, '$[1]')`, hashOnly.map(([date]) => [own.get(date).versionId, date]))))
      .map(r => [r.ship_date, [r.cost_cents, r.row_count]]));
    for (const [date] of hashOnly) {
      const seg = summary.perDate[date] || [0, 0], o = sums.get(date);
      if (!o || o[0] !== seg[0] || o[1] !== seg[1]) throw new ApiError(400, 'groups_mismatch', 'The groups do not reconcile with the validated segments for a date');
    }
  }
  const days = [];
  for (const [date, groups, hash] of b.days) days.push(groups === null ? { date, groups: null, hash, hashOnly: true }
    : { date, groups, hash: await dayHash(date, groups), costCents: groups.reduce((n, g) => n + g[1], 0), rowCount: groups.reduce((n, g) => n + g[2], 0) });
  const cov = await coverage(db);
  const reasons = versionReviewReasons({ flags: summary.flags || {}, firstVersion: !cov, coverage: cov, from: b.requestedFrom, to: b.requestedTo,
                                         exportedAt: declared.exportedAt || b.exportedAt, timeZone: s.shipping_report_timezone || 'America/Los_Angeles' });
  // Automatic acceptance rules (owner decision 2026-10-05): with auto-acceptance on AND
  // shipping_cost_auto_accept_rules = 'flag_and_accept', a version that passes the automated checks is
  // accepted without a person and its unusual values are flags; without that rule the earlier strict
  // auto-acceptance applies (any review reason or changed accepted cost waits for a decision).
  const enabled = s.shipping_cost_auto_accept_enabled === true;
  const auto = enabled && s.shipping_cost_auto_accept_rules === 'flag_and_accept';
  // Per-date classification against the current owners.
  const differing = days.filter(d => own.has(d.date) && own.get(d.date).dayHash !== d.hash);
  const ownerGroups = await dayGroupsOf(db, differing.map(d => [own.get(d.date).versionId, d.date]));
  // Automatic acceptance never drops an accepted cost the new report omits: it is kept explicitly
  // on the date, while the report's additions and corrections on the same date still apply.
  const omittedDates = [];
  if (auto && differing.length) {
    const ownerVids = [...new Set(differing.map(d => own.get(d.date).versionId))];
    const prev = new Map((await selectIn(db, "SELECT version_id, json_extract(outcome, '$.preserved') AS p FROM scr_version WHERE version_id IN (SELECT value FROM json_each(?1))", ownerVids))
      .map(r => [r.version_id, P(r.p, {}) || {}]));
    for (const d of differing) {
      const o = own.get(d.date);
      const m = mergePreserved({ groups: d.groups, ownerGroups: ownerGroups.get(`${o.versionId}|${d.date}`) || [], ownerPreserved: prev.get(o.versionId)?.[d.date] || [], ownerVersionId: o.versionId });
      if (!m.preserved.length) continue;
      omittedDates.push(d.date);
      d.groups = m.groups; d.preserved = m.preserved; d.hash = await dayHash(d.date, m.groups);
      d.costCents = m.groups.reduce((n, g) => n + g[1], 0); d.rowCount = m.groups.reduce((n, g) => n + g[2], 0);
    }
  }
  const newKeys = [...new Set(differing.flatMap(d => {
    const had = new Set((ownerGroups.get(`${own.get(d.date).versionId}|${d.date}`) || []).map(g => g[0]));
    return d.groups.map(g => g[0]).filter(k => !had.has(k));
  }))];
  const accepted = await keysWithAcceptedCost(db, newKeys);
  const outcome = {};
  for (const d of days) {
    const o = own.get(d.date);
    if (d.hashOnly) { d.outcome = 'identical'; outcome[d.date] = d.outcome; continue; }
    d.outcome = classifyDay({ day: d, owner: o ? { ...o, groups: ownerGroups.get(`${o.versionId}|${d.date}`) || [] } : null, acceptedKeys: accepted });
    outcome[d.date] = d.outcome;
  }
  // Automatic acceptance: with omitted costs kept, a date that still differs from its owner holds
  // corrections or additions to costed orders — late corrections, activated and flagged.
  if (auto) for (const d of days) if (d.outcome === 'held') { d.outcome = 'changed'; outcome[d.date] = 'changed'; }
  const count = k => days.filter(d => d.outcome === k).length;
  const counts = { new: count('new'), identical: count('identical'), fill_in: count('fill_in'), held: count('held'), ...(auto ? { changed: count('changed') } : {}) };
  // Owner rule (until 2026-10-05): nothing activates by itself unless auto-acceptance is explicitly enabled.
  if (!enabled && days.some(d => d.outcome !== 'identical')) reasons.push('auto_acceptance_disabled');
  const { invalid, flags } = auto ? autoDecision(reasons) : { invalid: [], flags: [] };
  if (auto && omittedDates.length) flags.push('accepted_cost_removed');
  if (auto && counts.changed) flags.push('changed_cost');
  const rejectInvalid = auto && invalid.length > 0;
  const review = !auto && reasons.length > 0;
  const activate = review || rejectInvalid ? [] : days.filter(d => ['new', 'fill_in', 'changed'].includes(d.outcome));
  const store = days.filter(d => d.outcome !== 'identical');
  const status = rejectInvalid ? 'rejected' : review ? 'pending_review' : counts.held ? 'partially_accepted' : activate.length ? 'accepted' : 'no_change';
  const versionId = newId('scr'), at = nowIso(), activationId = activate.length ? newId('sca') : null;
  const weeks = activate.length ? await affectedWeeks(db, activate) : [];
  // The weeks each flag concerns (ship weeks and the order weeks of the orders involved), recorded
  // whether or not this version owns any date, so the dashboard can show them on those weeks.
  const changedDays = days.filter(d => d.outcome === 'changed');
  const omittedDays = days.filter(d => d.preserved).map(d => ({ date: d.date, groups: d.preserved.map(([k]) => [k]) }));
  const changedWeeks = auto && changedDays.length ? await affectedWeeks(db, changedDays) : [];
  const omittedWeeks = auto && omittedDays.length ? await affectedWeeks(db, omittedDays) : [];
  const out = { reviewReasons: auto ? [] : reasons, counts, dates: outcome, affectedWeeks: weeks, heldDates: days.filter(d => d.outcome === 'held').map(d => d.date),
                ...(auto ? { automatic: true, flags, ...(rejectInvalid ? { invalidReasons: invalid } : {}),
                             changedDates: days.filter(d => d.outcome === 'changed').map(d => d.date),
                             // Dates where this report omitted accepted costs (kept), whether or not it activates them.
                             omittedDates, changedWeeks, omittedWeeks,
                             ...(activate.some(d => d.preserved) ? { preserved: Object.fromEntries(activate.filter(d => d.preserved).map(d => [d.date, d.preserved])) } : {}) } : {}) };
  const dayOutcome = d => (review ? 'pending' : rejectInvalid ? 'rejected_invalid' : d.outcome);
  const stmts = [
    db.prepare(`INSERT INTO scr_version (version_id, source_id, requested_from, requested_to, exported_at, imported_at, status, outcome)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`).bind(versionId, src.source_id, b.requestedFrom, b.requestedTo, declared.exportedAt || b.exportedAt || null, at, status, JSON.stringify(out)),
    ...store.map(d => db.prepare('INSERT INTO scr_day (version_id, ship_date, day_hash, cost_cents, row_count, groups, outcome) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
      .bind(versionId, d.date, d.hash, d.costCents, d.rowCount, JSON.stringify(d.groups), dayOutcome(d))),
    // The day's order keys, for indexed lookups (one row per order of the stored day).
    ...store.filter(d => d.groups.length).map(d => db.prepare("INSERT OR IGNORE INTO scr_day_key (order_key, version_id, ship_date) SELECT json_extract(value, '$[0]'), ?1, ?2 FROM json_each(?3)")
      .bind(versionId, d.date, JSON.stringify(d.groups))),
  ];
  if (activate.length) stmts.push(...activationStatements(db, { activationId, versionId, at, actorCls: 'ingest_secret', days: activate, own, weeks }),
    decisionStmt(db, { versionId, kind: 'auto_activate', at, actor: { cls: 'ingest_secret', label: 'collector' },
                       reason: `automatic: passed automated checks${flags.length ? `; flagged ${flags.join(', ')}` : ''}${counts.changed ? `; ${counts.changed} date(s) with changed cost` : ''}`,
                       dates: activate.map(d => d.date), weeks }));
  if (rejectInvalid) stmts.push(decisionStmt(db, { versionId, kind: 'auto_reject_invalid', at, actor: { cls: 'ingest_secret', label: 'collector' },
                       reason: `automatic: failed automated checks (${invalid.join(', ')}); re-exported on the next attempt`, dates: [], weeks: [] }));
  try { await atomic(db, stmts); }
  catch (e) {
    // A duplicate delivery of the same upload raced this one: the first version stands.
    const first = /UNIQUE constraint failed: scr_version\.source_id/i.test(String(e?.message || e))
      && await db.prepare('SELECT version_id, status, outcome FROM scr_version WHERE source_id = ?1').bind(src.source_id).first();
    if (first) return json({ versionId: first.version_id, status: first.status, ...P(first.outcome, {}), duplicate: true });
    throw e;
  }
  return json({ versionId, status, ...out });
}

function activationStatements(db, { activationId, versionId, at, actorCls, days, own, weeks }) {
  const prev = days.map(d => [d.date, own.get(d.date)?.versionId || null, own.get(d.date)?.dayHash || null]);
  return [
    db.prepare('INSERT INTO scr_activation (activation_id, version_id, at, actor_class, dates, weeks) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(activationId, versionId, at, actorCls, JSON.stringify(prev), JSON.stringify(weeks)),
    ...days.map(d => db.prepare(`INSERT INTO scr_day_owner (ship_date, version_id, day_hash, activation_id) VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(ship_date) DO UPDATE SET version_id = excluded.version_id, day_hash = excluded.day_hash, activation_id = excluded.activation_id`)
      .bind(d.date, versionId, d.hash, activationId)),
  ];
}

// ─── Reads shared by the collector and the verifier ───────────────────────────

/** The current owner hash of every owned date in [from, to] (≤ MAX_DAYS): lets the collector send unchanged dates as a hash. */
export async function getScrOwners(request, env) {
  const b = await readJson(request);
  if (!DATE.test(b.from || '') || !DATE.test(b.to || '') || b.from > b.to || addDays(b.from, MAX_DAYS) <= b.to) throw new ApiError(400, 'bad_payload', `from / to: YYYY-MM-DD, at most ${MAX_DAYS} days`);
  const own = await owners(env.DB, b.from, b.to);
  return json({ owners: [...own].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([d, o]) => [d, o.dayHash]) });
}

export async function getScrDays(request, env) {
  const b = await readJson(request);
  const keys = Array.isArray(b.keys) ? b.keys : [];
  if (keys.length > 400 || keys.some(k => !Array.isArray(k) || !/^scr_[0-9a-f]{20}$/.test(k[0]) || !DATE.test(k[1]))) throw new ApiError(400, 'bad_payload', 'keys: ≤ 400 [versionId, date] pairs');
  const rows = keys.length ? await selectIn(env.DB, `SELECT d.version_id, d.ship_date, d.day_hash, d.groups FROM scr_day d
      JOIN json_each(?1) j ON d.version_id = json_extract(j.value, '$[0]') AND d.ship_date = json_extract(j.value, '$[1]')`, keys) : [];
  return json({ days: rows.map(r => [r.version_id, r.ship_date, r.day_hash, r.groups]) });
}

// ─── Week basis (C8 rule on date ownership) ───────────────────────────────────

/**
 * ok        every date of the week is owned by an accepted version and the owner of
 *           the last date was received after the week closed
 * partial   some dates owned (or the last owner arrived before the week closed)
 * pending_review  a version covering the week is waiting for review; not enough owned
 * missing   nothing
 * Same record shape as compute.js basisRecord(), so gate and engine read it unchanged.
 */
/** Versions a week's basis reads: the owners of its dates, and any version overlapping it that is still in review. */
export const BASIS_VERSIONS_SQL = `SELECT v.*, o.sha256 FROM scr_version v JOIN src_object o ON o.source_id = v.source_id
      WHERE (v.requested_from <= ?2 AND v.requested_to >= ?1 AND v.status IN ('pending_review','partially_accepted')) OR v.version_id IN (SELECT value FROM json_each(?3))`;
export async function scrBasis(db, weekStart, closedAt) {
  const weekEnd = addDays(weekStart, 6);
  const own = await owners(db, weekStart, weekEnd);
  const vids = [...new Set([...own.values()].map(o => o.versionId))];
  const vrows = await db.prepare(BASIS_VERSIONS_SQL).bind(weekStart, weekEnd, JSON.stringify(vids)).all();
  return scrBasisFrom({ weekStart, closedAt, own, versionRows: vrows.results || [] });
}
/** Pure: the basis from the week's date owners (Map date → { versionId }) and the version rows. */
export function scrBasisFrom({ weekStart, closedAt, own, versionRows }) {
  const weekEnd = addDays(weekStart, 6);
  const versions = new Map();
  for (const v of versionRows) versions.set(v.version_id, v);
  const vjson = v => ({ versionId: v.version_id, sha256: v.sha256 || null, requestedFrom: v.requested_from, requestedTo: v.requested_to,
                        receivedAt: v.imported_at, state: v.status === 'partially_accepted' || v.status === 'accepted' ? 'accepted' : v.status, decidedAt: v.decided_at || null });
  const used = [];
  for (let d = weekStart; d <= weekEnd; d = addDays(d, 1)) {
    const o = own.get(d);
    const last = used[used.length - 1];
    if (o && last && last.versionId === o.versionId && addDays(last.weekDatesTo, 1) === d) last.weekDatesTo = d;
    else if (o) used.push({ ...vjson(versions.get(o.versionId) || { version_id: o.versionId }), weekDatesFrom: d, weekDatesTo: d });
  }
  const covered = own.size === 7 && used.every((u, i) => i === 0 ? u.weekDatesFrom === weekStart : addDays(used[i - 1].weekDatesTo, 1) === u.weekDatesFrom);
  const lastUsed = used[used.length - 1];
  const newestUsed = used.reduce((m, u) => (u.receivedAt > m ? u.receivedAt : m), '');
  const pending = [...versions.values()].filter(v => (v.status === 'pending_review' || (v.status === 'partially_accepted' && heldInWeek(v, weekStart, weekEnd))) && v.imported_at > newestUsed).map(vjson);
  if (covered && lastUsed.receivedAt >= closedAt) {
    return { status: 'accepted', basisStatus: 'ok', used, newerPending: pending,
             label: pending.length ? 'Newer shipping report pending review' : null,
             signature: `${used.map(u => `${u.versionId}@${u.weekDatesFrom}..${u.weekDatesTo}`).join(',')}|pending:${pending.map(v => v.versionId).join(',')}`,
             versionId: lastUsed.versionId, requestedFrom: lastUsed.requestedFrom, requestedTo: lastUsed.requestedTo };
  }
  const pendingFull = [...versions.values()].filter(v => v.status === 'pending_review' && v.requested_from <= weekStart && v.requested_to >= weekEnd);
  const status = pendingFull.length ? 'pending_review' : used.length ? 'partial' : 'missing';
  return { status, basisStatus: status, used: [], acceptedCoverage: used, newerPending: [], pendingReview: pendingFull.map(vjson),
           label: status === 'pending_review' ? 'Shipping Cost Report received; pending review'
                : status === 'partial' ? 'Accepted Shipping Cost Report data does not cover the whole week' : 'No Shipping Cost Report for this week',
           signature: null, versionId: null, requestedFrom: null, requestedTo: null };
}
function heldInWeek(v, from, to) {
  // An automatically decided version never holds a date (omitted accepted costs are kept on the
  // activated date and flagged `accepted_cost_removed`), so it never blocks a week.
  if (P(v.outcome, {})?.automatic === true) return false;
  const held = P(v.outcome, {})?.heldDates || [];
  return held.some(d => d >= from && d <= to);
}

// ─── Admin decisions ─────────────────────────────────────────────────────────

const decisionStmt = (db, { versionId, kind, at, actor, reason, dates, weeks }) =>
  db.prepare('INSERT INTO scr_decision (decision_id, version_id, kind, at, actor_class, actor_label, reason, dates, weeks) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)')
    .bind(newId('scd'), versionId, kind, at, actor.cls, actor.label || null, reason, JSON.stringify(dates), JSON.stringify(weeks));
/** The decision applies only if the version is still in the state it was read in (a concurrent decision aborts the batch). */
const stateGuard = (db, id, status) => db.prepare('INSERT INTO write_guard (ok) SELECT NULL WHERE NOT EXISTS (SELECT 1 FROM scr_version WHERE version_id = ?1 AND status = ?2)').bind(id, status);
const isGuardAbort = e => /NOT NULL constraint failed: write_guard/i.test(String(e?.message || e));
const weeksOfDates = dates => [...new Set(dates.map(weekStartOf))].sort();

const reasonOf = body => { const r = String(body?.reason || '').trim(); if (r.length < 5) throw new ApiError(400, 'bad_payload', 'A decision needs a stated reason'); return r; };

/** Weeks overlapping `before`'s range whose Shipping Cost Report basis differs when `before` is replaced by `after`. Admin route; three reads. */
async function basisChangedWeeks(db, before, after) {
  const first = weekStartOf(before.requested_from), last = weekStartOf(before.requested_to);
  const weeks = []; for (let w = first; w <= last; w = addDays(w, 7)) weeks.push(w);
  const tz = (await getSettings(db)).store_timezone;
  const ownAll = await owners(db, first, addDays(last, 6));
  const rows = (await db.prepare(BASIS_VERSIONS_SQL).bind(first, addDays(last, 6), JSON.stringify([...new Set([...ownAll.values()].map(o => o.versionId))])).all()).results || [];
  const out = [];
  for (const w of weeks) {
    const we = addDays(w, 6), own = new Map([...ownAll].filter(([d]) => d >= w && d <= we));
    const vids = new Set([...own.values()].map(o => o.versionId));
    const inWeek = r => vids.has(r.version_id) || (r.requested_from <= we && r.requested_to >= w && ['pending_review', 'partially_accepted'].includes(r.status));
    const closedAt = weekWindowUtc(w, tz).endUtcExclusive;
    const a = scrBasisFrom({ weekStart: w, closedAt, own, versionRows: rows.filter(inWeek) });
    const b = scrBasisFrom({ weekStart: w, closedAt, own, versionRows: rows.map(r => (r.version_id === before.version_id ? { ...r, ...after, sha256: r.sha256 } : r)).filter(inWeek) });
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(w);
  }
  return out;
}

export async function listScrVersions(env) {
  const r = (await env.DB.prepare('SELECT version_id, source_id, requested_from, requested_to, exported_at, imported_at, status, outcome, decided_at FROM scr_version ORDER BY imported_at DESC LIMIT 100').all()).results || [];
  return json({ versions: r.map(v => { const o = P(v.outcome, {}); return { versionId: v.version_id, sourceId: v.source_id, requestedFrom: v.requested_from, requestedTo: v.requested_to,
    exportedAt: v.exported_at, importedAt: v.imported_at, status: v.status, reviewReasons: o.reviewReasons || [], counts: o.counts || {}, heldDates: o.heldDates || [], decidedAt: v.decided_at }; }) });
}

export async function getScrVersion(env, id) {
  const db = env.DB;
  const v = await db.prepare('SELECT * FROM scr_version WHERE version_id = ?1').bind(id).first();
  if (!v) throw new ApiError(404, 'version_unknown', 'No such version');
  const o = P(v.outcome, {});
  const stored = (await db.prepare('SELECT ship_date, day_hash, cost_cents, row_count, groups, outcome FROM scr_day WHERE version_id = ?1 ORDER BY ship_date').bind(id).all()).results || [];
  const own = await owners(db, v.requested_from, v.requested_to);
  const cur = await dayGroupsOf(db, stored.filter(d => own.has(d.ship_date) && own.get(d.ship_date).versionId !== id).map(d => [own.get(d.ship_date).versionId, d.ship_date]));
  // Admin-only review detail: per-order before/after for held or pending dates.
  const review = stored.filter(d => d.outcome === 'held' || d.outcome === 'pending').map(d => {
    const now = new Map(P(d.groups, []).map(g => [g[0], g]));
    const o2 = own.get(d.ship_date);
    const before = new Map((o2 && o2.versionId !== id ? cur.get(`${o2.versionId}|${d.ship_date}`) || [] : []).map(g => [g[0], g]));
    const changes = [];
    for (const k of [...new Set([...now.keys(), ...before.keys()])].sort()) {
      const a = before.get(k), b = now.get(k);
      if (!a || !b || a[1] !== b[1] || a[2] !== b[2]) changes.push({ orderKey: k, beforeCents: a ? a[1] : null, afterCents: b ? b[1] : null, beforeRows: a ? a[2] : null, afterRows: b ? b[2] : null });
    }
    return { date: d.ship_date, outcome: d.outcome, currentOwner: o2?.versionId || null, changes };
  });
  return json({ versionId: id, status: v.status, requestedFrom: v.requested_from, requestedTo: v.requested_to, importedAt: v.imported_at,
                reviewReasons: o.reviewReasons || [], counts: o.counts || {}, dates: o.dates || {}, affectedWeeks: o.affectedWeeks || [], review,
                decidedAt: v.decided_at, decisionReason: v.decision_reason });
}

export async function acceptScrVersion(request, env, id) {
  const body = await readJson(request);
  const reason = reasonOf(body);
  const db = env.DB;
  const v = await db.prepare('SELECT * FROM scr_version WHERE version_id = ?1').bind(id).first();
  if (!v) throw new ApiError(404, 'version_unknown', 'No such version');
  if (!['pending_review', 'partially_accepted'].includes(v.status)) throw new ApiError(409, 'not_reviewable', `Version is ${v.status}`);
  const stored = (await db.prepare("SELECT ship_date, day_hash, groups FROM scr_day WHERE version_id = ?1 AND outcome IN ('pending','held','new','fill_in') ORDER BY ship_date").bind(id).all()).results || [];
  const own = await owners(db, v.requested_from, v.requested_to);
  const days = stored.filter(d => own.get(d.ship_date)?.versionId !== id).map(d => ({ date: d.ship_date, hash: d.day_hash, groups: P(d.groups, []) }));
  const actor = actorFor('admin_secret', body), at = nowIso(), activationId = newId('sca');
  const weeks = days.length ? await affectedWeeks(db, days) : [];
  const o = { ...P(v.outcome, {}), affectedWeeks: [...new Set([...(P(v.outcome, {}).affectedWeeks || []), ...weeks])].sort(), heldDates: [] };
  const decisionWeeks = [...new Set([...weeks, ...weeksOfDates(stored.map(d => d.ship_date))])].sort();
  try {
    await atomic(db, [
      stateGuard(db, id, v.status),
      db.prepare("UPDATE scr_version SET status = 'accepted', decided_at = ?2, decided_by = ?3, decision_reason = ?4, outcome = ?5 WHERE version_id = ?1 AND status IN ('pending_review','partially_accepted')")
        .bind(id, at, actor.cls, reason, JSON.stringify(o)),
      db.prepare("UPDATE scr_day SET outcome = 'activated_on_review' WHERE version_id = ?1 AND outcome IN ('pending','held')").bind(id),
      ...(days.length ? activationStatements(db, { activationId, versionId: id, at, actorCls: actor.cls, days, own, weeks }) : []),
      decisionStmt(db, { versionId: id, kind: 'accept', at, actor, reason, dates: days.map(d => d.date), weeks: decisionWeeks }),
    ]);
  } catch (e) { if (isGuardAbort(e)) throw new ApiError(409, 'not_reviewable', 'The version was decided concurrently'); throw e; }
  return json({ versionId: id, status: 'accepted', activatedDates: days.map(d => d.date), affectedWeeks: decisionWeeks });
}

/**
 * pending_review      → the whole version is rejected; nothing of it was ever activated.
 * partially_accepted  → only its HELD dates are rejected: the dates it already activated
 *                       stay in force, the accepted costs the held dates would have changed
 *                       stay as they are, and the version counts as accepted from now on, so
 *                       its held dates no longer block publication ("newer report pending").
 *                       The weeks of those dates need a new draft revision without the block;
 *                       their week status shows `compute_pending` until it exists.
 */
export async function rejectScrVersion(request, env, id) {
  const body = await readJson(request);
  const reason = reasonOf(body);
  const actor = actorFor('admin_secret', body);
  const db = env.DB;
  const v = await db.prepare('SELECT * FROM scr_version WHERE version_id = ?1').bind(id).first();
  if (!v) throw new ApiError(404, 'version_unknown', 'No such version');
  if (!['pending_review', 'partially_accepted'].includes(v.status)) throw new ApiError(409, 'not_reviewable', `Version is ${v.status}`);
  const at = nowIso(), o = P(v.outcome, {});
  const dayOutcome = v.status === 'pending_review' ? 'pending' : 'held';
  const dates = ((await db.prepare('SELECT ship_date FROM scr_day WHERE version_id = ?1 AND outcome = ?2 ORDER BY ship_date').bind(id, dayOutcome).all()).results || []).map(r => r.ship_date);
  const whole = v.status === 'pending_review';
  const next = whole ? 'rejected' : 'accepted';
  const outcome = { ...o, heldDates: [], rejectedDates: [...new Set([...(o.rejectedDates || []), ...dates])].sort() };
  // Rejection changes no owner, only week bases (their pending lists): the affected weeks are
  // exactly those whose basis differs once the version has its new state.
  const weeks = await basisChangedWeeks(db, v, { ...v, status: next, outcome: JSON.stringify(outcome) });
  try {
    await atomic(db, [
      stateGuard(db, id, v.status),
      db.prepare('UPDATE scr_version SET status = ?2, decided_at = ?3, decided_by = ?4, decision_reason = ?5, outcome = ?6 WHERE version_id = ?1 AND status = ?7')
        .bind(id, next, at, actor.cls, reason, JSON.stringify(outcome), v.status),
      db.prepare("UPDATE scr_day SET outcome = 'rejected_on_review' WHERE version_id = ?1 AND outcome = ?2").bind(id, dayOutcome),
      decisionStmt(db, { versionId: id, kind: whole ? 'reject_version' : 'reject_held', at, actor, reason, dates, weeks }),
    ]);
  } catch (e) { if (isGuardAbort(e)) throw new ApiError(409, 'not_reviewable', 'The version was decided concurrently'); throw e; }
  return json({ versionId: id, status: next, rejectedDates: dates, affectedWeeks: weeks });
}

export async function rollbackScrActivation(request, env, activationId) {
  const body = await readJson(request);
  reasonOf(body);
  const db = env.DB;
  const latest = await db.prepare('SELECT * FROM scr_activation ORDER BY at DESC, activation_id DESC LIMIT 1').first();
  if (!latest || latest.activation_id !== activationId) throw new ApiError(409, 'not_latest_activation', 'Only the latest activation can be rolled back');
  const prev = P(latest.dates, []);
  const reason = String(body.reason).trim(), actor = actorFor('admin_secret', body), at = nowIso();
  await atomic(db, [
    ...prev.map(([date, vid, hash]) => vid
      ? db.prepare('UPDATE scr_day_owner SET version_id = ?2, day_hash = ?3, activation_id = ?4 WHERE ship_date = ?1').bind(date, vid, hash, `rollback:${activationId}`)
      : db.prepare('DELETE FROM scr_day_owner WHERE ship_date = ?1').bind(date)),
    db.prepare('DELETE FROM scr_activation WHERE activation_id = ?1').bind(activationId),
    decisionStmt(db, { versionId: latest.version_id, kind: 'rollback', at, actor, reason, dates: prev.map(p => p[0]),
                       weeks: [...new Set([...P(latest.weeks, []), ...weeksOfDates(prev.map(p => p[0]))])].sort() }),
  ]);
  return json({ activationId, rolledBack: true, dates: prev.map(p => p[0]), affectedWeeks: P(latest.weeks, []) });
}
