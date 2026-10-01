/**
 * collectScr.js — Shipping Cost Report versions at ship-date level (Free-tier path)
 * ================================================================================
 * POST /v1/collect/scr/versions            { sourceId, requestedFrom, requestedTo, exportedAt, days: [[date, groups]] }
 * POST /v1/collect/scr/days                { keys: [[versionId, date]] } → groups   (ingest or verify)
 * GET  /v1/admin/scr/versions              list (codes and counts only)
 * GET  /v1/admin/scr/versions/:id          one version: per-date outcomes; held dates with per-order before/after (admin only)
 * POST /v1/admin/scr/versions/:id/accept   { reason }  activate everything the version still holds for review
 * POST /v1/admin/scr/versions/:id/reject   { reason }
 * POST /v1/admin/scr/activations/:id/rollback { reason }   undo the LATEST activation exactly
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
import { dayHash, classifyDay, versionReviewReasons } from '../../shared/scrDays.js';

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
/** Which of these order keys already have accepted cost on some owned date (evaluated in D1, not Worker CPU). */
async function keysWithAcceptedCost(db, keys) {
  if (!keys.length) return new Set();
  const rows = await selectIn(db, `SELECT DISTINCT json_extract(g.value, '$[0]') AS k FROM scr_day_owner o
      JOIN scr_day d ON d.version_id = o.version_id AND d.ship_date = o.ship_date, json_each(d.groups) g
      WHERE json_extract(g.value, '$[0]') IN (SELECT value FROM json_each(?1))`, keys);
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
  for (const [date, groups] of b.days) {
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
  const days = [];
  for (const [date, groups] of b.days) days.push({ date, groups, hash: await dayHash(date, groups),
    costCents: groups.reduce((n, g) => n + g[1], 0), rowCount: groups.reduce((n, g) => n + g[2], 0) });
  const own = await owners(db, b.requestedFrom, b.requestedTo);
  const cov = await coverage(db);
  const reasons = versionReviewReasons({ flags: summary.flags || {}, firstVersion: !cov, coverage: cov, from: b.requestedFrom, to: b.requestedTo,
                                         exportedAt: declared.exportedAt || b.exportedAt, timeZone: s.shipping_report_timezone || 'America/Los_Angeles' });
  // Per-date classification against the current owners.
  const differing = days.filter(d => own.has(d.date) && own.get(d.date).dayHash !== d.hash);
  const ownerGroups = await dayGroupsOf(db, differing.map(d => [own.get(d.date).versionId, d.date]));
  const newKeys = [...new Set(differing.flatMap(d => {
    const had = new Set((ownerGroups.get(`${own.get(d.date).versionId}|${d.date}`) || []).map(g => g[0]));
    return d.groups.map(g => g[0]).filter(k => !had.has(k));
  }))];
  const accepted = await keysWithAcceptedCost(db, newKeys);
  const outcome = {};
  for (const d of days) {
    const o = own.get(d.date);
    d.outcome = classifyDay({ day: d, owner: o ? { ...o, groups: ownerGroups.get(`${o.versionId}|${d.date}`) || [] } : null, acceptedKeys: accepted });
    outcome[d.date] = d.outcome;
  }
  const count = k => days.filter(d => d.outcome === k).length;
  const counts = { new: count('new'), identical: count('identical'), fill_in: count('fill_in'), held: count('held') };
  // Owner rule: nothing activates by itself unless auto-acceptance is explicitly enabled.
  if (s.shipping_cost_auto_accept_enabled !== true && days.some(d => d.outcome !== 'identical')) reasons.push('auto_acceptance_disabled');
  const review = reasons.length > 0;
  const activate = review ? [] : days.filter(d => d.outcome === 'new' || d.outcome === 'fill_in');
  const store = days.filter(d => d.outcome !== 'identical');
  const status = review ? 'pending_review' : counts.held ? 'partially_accepted' : activate.length ? 'accepted' : 'no_change';
  const versionId = newId('scr'), at = nowIso(), activationId = activate.length ? newId('sca') : null;
  const weeks = activate.length ? await affectedWeeks(db, activate) : [];
  const out = { reviewReasons: reasons, counts, dates: outcome, affectedWeeks: weeks, heldDates: days.filter(d => d.outcome === 'held').map(d => d.date) };
  const stmts = [
    db.prepare(`INSERT INTO scr_version (version_id, source_id, requested_from, requested_to, exported_at, imported_at, status, outcome)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`).bind(versionId, src.source_id, b.requestedFrom, b.requestedTo, declared.exportedAt || b.exportedAt || null, at, status, JSON.stringify(out)),
    ...store.map(d => db.prepare('INSERT INTO scr_day (version_id, ship_date, day_hash, cost_cents, row_count, groups, outcome) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
      .bind(versionId, d.date, d.hash, d.costCents, d.rowCount, JSON.stringify(d.groups), review ? 'pending' : d.outcome)),
  ];
  if (activate.length) stmts.push(...activationStatements(db, { activationId, versionId, at, actorCls: 'ingest_secret', days: activate, own, weeks }));
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
  const held = P(v.outcome, {})?.heldDates || [];
  return held.some(d => d >= from && d <= to);
}

// ─── Admin decisions ─────────────────────────────────────────────────────────

const reasonOf = body => { const r = String(body?.reason || '').trim(); if (r.length < 5) throw new ApiError(400, 'bad_payload', 'A decision needs a stated reason'); return r; };

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
  await atomic(db, [
    db.prepare("UPDATE scr_version SET status = 'accepted', decided_at = ?2, decided_by = ?3, decision_reason = ?4, outcome = ?5 WHERE version_id = ?1 AND status IN ('pending_review','partially_accepted')")
      .bind(id, at, actor.cls, reason, JSON.stringify(o)),
    db.prepare("UPDATE scr_day SET outcome = 'activated_on_review' WHERE version_id = ?1 AND outcome IN ('pending','held')").bind(id),
    ...(days.length ? activationStatements(db, { activationId, versionId: id, at, actorCls: actor.cls, days, own, weeks }) : []),
  ]);
  return json({ versionId: id, status: 'accepted', activatedDates: days.map(d => d.date), affectedWeeks: weeks });
}

export async function rejectScrVersion(request, env, id) {
  const body = await readJson(request);
  const reason = reasonOf(body);
  const actor = actorFor('admin_secret', body);
  const r = await env.DB.prepare("UPDATE scr_version SET status = 'rejected', decided_at = ?2, decided_by = ?3, decision_reason = ?4 WHERE version_id = ?1 AND status = 'pending_review'")
    .bind(id, nowIso(), actor.cls, reason).run();
  if (r.meta.changes !== 1) throw new ApiError(409, 'not_reviewable', 'Only a version pending review can be rejected (held dates of a partially accepted version stay held)');
  return json({ versionId: id, status: 'rejected' });
}

export async function rollbackScrActivation(request, env, activationId) {
  const body = await readJson(request);
  reasonOf(body);
  const db = env.DB;
  const latest = await db.prepare('SELECT * FROM scr_activation ORDER BY at DESC, activation_id DESC LIMIT 1').first();
  if (!latest || latest.activation_id !== activationId) throw new ApiError(409, 'not_latest_activation', 'Only the latest activation can be rolled back');
  const prev = P(latest.dates, []);
  await atomic(db, [
    ...prev.map(([date, vid, hash]) => vid
      ? db.prepare('UPDATE scr_day_owner SET version_id = ?2, day_hash = ?3, activation_id = ?4 WHERE ship_date = ?1').bind(date, vid, hash, `rollback:${activationId}`)
      : db.prepare('DELETE FROM scr_day_owner WHERE ship_date = ?1').bind(date)),
    db.prepare('DELETE FROM scr_activation WHERE activation_id = ?1').bind(activationId),
  ]);
  return json({ activationId, rolledBack: true, dates: prev.map(p => p[0]), affectedWeeks: P(latest.weeks, []) });
}
