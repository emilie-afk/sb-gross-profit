/**
 * admin.js — /v1/admin routes (X-Admin-Secret)
 */
import { ApiError, json, readJson, WEEK_RE } from './http.js';
import { getSettings, validateSetting, REASON_REQUIRED, nowIso, newId, selectIn, atomic } from './db.js';
import { computeWeek, computeScheduledWeek, recomputeScheduledRun, publishSnapshot, readiness, latestRefresh, weekAnchor, REFRESH_TIMEOUT_MINUTES } from './compute.js';
import { actorFor, actorJson } from './actor.js';
import { getRun, createRun } from './runs.js';
import { loadShipmentsForOrders, latestAcceptedCatalogMeta } from './store.js';
import { weekStartOf, addDays, toStoreLocal, businessDateOf } from '../../shared/normalized.js';
import { planCycle } from '../../shared/schedule.js';
import { compareCarrierFeeToRate, classifyInsuranceTreatment } from '../../shared/adapters/shipstation.js';

const TRIGGERS = new Set(['schedule', 'manual']);
const mondayOrThrow = w => {
  if (!WEEK_RE.test(w || '') || weekStartOf(w) !== w) throw new ApiError(400, 'bad_payload', 'weekStart must be a Monday, YYYY-MM-DD');
  return w;
};
const reasonOrThrow = (r, what, min = 5) => {
  const s = String(r || '').trim();
  if (s.length < min) throw new ApiError(400, 'bad_payload', `${what} needs a stated reason`);
  return s;
};

export async function createAndCompute(request, env) {
  const body = await readJson(request);
  mondayOrThrow(body.weekStart);
  const trigger = body.trigger || 'manual';
  if (!TRIGGERS.has(trigger)) throw new ApiError(400, 'bad_payload', "trigger must be 'schedule' or 'manual'");
  const actor = actorFor('admin_secret', body);
  if (trigger === 'schedule') {
    if (body.acceptCatalogReuse) throw new ApiError(400, 'bad_payload', 'A scheduled run cannot accept catalog reuse; recompute the run instead');
    return json(runResult(await computeScheduledWeek(env, { weekStart: body.weekStart, actor })));
  }
  const r = await computeWeek(env, { weekStart: body.weekStart, trigger, actor, reason: body.reason || null,
                                     acceptCatalogReuse: body.acceptCatalogReuse || null });
  return json(runResult(r));
}

export async function recompute(request, env, runId) {
  const body = await readJson(request);
  const actor = actorFor('admin_secret', body);
  const run = await getRun(env.DB, runId);
  // A scheduled run is recomputed only as the owner of its cycle (claim-guarded).
  if (run.trigger === 'schedule') {
    return json(runResult(await recomputeScheduledRun(env, { runId, actor, reason: body.reason || null, acceptance: body.acceptCatalogReuse || null })));
  }
  const r = await computeWeek(env, { runId, trigger: 'recompute', actor, reason: body.reason || null,
                                     acceptCatalogReuse: body.acceptCatalogReuse || null });
  return json(runResult(r));
}

/** An ordinary revision keeps the week's catalog (published snapshot's, else latest snapshot's). */
export async function revise(request, env) {
  const body = await readJson(request);
  mondayOrThrow(body.weekStart);
  const reason = reasonOrThrow(body.reason, 'A revision');
  const r = await computeWeek(env, { weekStart: body.weekStart, trigger: 'revision', actor: actorFor('admin_secret', body), reason,
                                     acceptCatalogReuse: body.acceptCatalogReuse || null });
  return json(runResult(r));
}

/**
 * Cost restatement: the ONLY way a week that already has a snapshot gets a
 * different cost catalog. Audited (who, why, from → to) and never published
 * automatically.
 */
export async function restateCosts(request, env) {
  const body = await readJson(request);
  const weekStart = mondayOrThrow(body.weekStart);
  const reason = reasonOrThrow(body.reason, 'A cost restatement', 10);
  const db = env.DB;
  const target = body.catalogRev
    ? await db.prepare("SELECT catalog_rev, captured_at FROM cost_catalog WHERE catalog_rev = ?1 AND status = 'accepted'").bind(body.catalogRev).first()
    : await latestAcceptedCatalogMeta(db);
  if (!target) throw new ApiError(404, 'catalog_unknown', 'No such accepted catalog');
  const anchor = await weekAnchor(db, weekStart);
  if (!anchor) throw new ApiError(409, 'nothing_to_restate', `The week of ${weekStart} has no snapshot yet; compute it normally`);
  if (anchor.rev === target.catalog_rev) throw new ApiError(409, 'catalog_unchanged', `The week already uses ${target.catalog_rev}`);
  const actor = actorFor('admin_secret', body);
  const run = await createRun(db, weekStart, 'cost_restatement', actor, reason);
  const restatementId = newId('rst');
  const info = { rev: target.catalog_rev, capturedAt: target.captured_at, basis: 'cost_restatement', restatementId,
                 fromCatalogRev: anchor.rev, fromSnapshotId: anchor.fromSnapshotId, refreshId: null };
  await atomic(db, [
    db.prepare('UPDATE reporting_run SET catalog_rev = ?2, catalog_info = ?3 WHERE run_id = ?1').bind(run.run_id, info.rev, JSON.stringify(info)),
    db.prepare(`INSERT INTO cost_restatement (restatement_id, week_start, run_id, from_catalog_rev, to_catalog_rev, reason, actor_class, actor_label, at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`).bind(restatementId, weekStart, run.run_id, anchor.rev, info.rev, reason, actor.cls, actor.label, nowIso()),
  ]);
  const r = await computeWeek(env, { runId: run.run_id, trigger: 'cost_restatement', actor, reason });
  return json({ ...runResult(r), restatement: { restatementId, fromCatalogRev: anchor.rev, toCatalogRev: info.rev, reason, ...actorJson(actor) } });
}

export async function listRestatements(request, env) {
  const url = new URL(request.url);
  const week = url.searchParams.get('weekStart');
  const rows = (await env.DB.prepare('SELECT * FROM cost_restatement WHERE (?1 IS NULL OR week_start = ?1) ORDER BY at DESC LIMIT 200')
    .bind(week || null).all()).results || [];
  return json({ restatements: rows.map(({ actor_class, actor_label, ...r }) => ({ ...r, actorClass: actor_class, actorLabel: actor_label })),
                note: 'actorClass is assigned from the authentication path; actorLabel is caller-supplied and not verified identity.' });
}

const runResult = r => ({ runId: r.run.run_id, state: r.run.state, weekStart: r.run.week_start, snapshotId: r.snapshotId,
  revision: r.revision, snapshotStatus: r.status, profitabilityStatus: r.profitabilityStatus, headline: r.headline, gate: r.gate,
  ...(r.existing ? { existing: true } : {}), ...(r.inProgress ? { inProgress: true } : {}), ...(r.resumed ? { resumed: true } : {}),
  ...(r.cycle ? { cycle: r.cycle } : {}) });

// ─── Schedule, readiness, catalog refresh ─────────────────────────────────────

export async function weekPlan(request, env) {
  const url = new URL(request.url);
  const at = url.searchParams.get('at') ? new Date(url.searchParams.get('at')) : new Date();
  if (isNaN(at)) throw new ApiError(400, 'bad_query', 'at must be an ISO timestamp');
  const s = await getSettings(env.DB);
  return json(planCycle(at, { schedule: { timeZone: s.schedule_timezone, weekday: Number(s.schedule_weekday), time: s.schedule_time },
                              reportingTimeZone: s.store_timezone }));
}

export async function getReadiness(request, env) {
  const url = new URL(request.url);
  const weekStart = mondayOrThrow(url.searchParams.get('weekStart'));
  return json(await readiness(env.DB, weekStart, await getSettings(env.DB)));
}

export async function createCatalogRefresh(request, env) {
  const body = await readJson(request);
  const weekStart = mondayOrThrow(body.weekStart);
  const id = newId('crf');
  const actor = actorFor('admin_secret', body);
  await env.DB.prepare("INSERT INTO catalog_refresh (refresh_id, week_start, requested_at, requested_by_class, requested_by_label, status) VALUES (?1, ?2, ?3, ?4, ?5, 'pending')")
    .bind(id, weekStart, nowIso(), actor.cls, actor.label).run();
  return json({ refreshId: id, weekStart, status: 'pending', timeoutMinutes: REFRESH_TIMEOUT_MINUTES,
                hookBody: { refreshId: id, weekStart } });
}

export async function getCatalogRefresh(env, refreshId) {
  const r = await env.DB.prepare('SELECT week_start FROM catalog_refresh WHERE refresh_id = ?1').bind(refreshId).first();
  if (!r) throw new ApiError(404, 'refresh_unknown', `No catalog refresh ${refreshId}`);
  const latest = await latestRefresh(env.DB, r.week_start);
  const row = await env.DB.prepare('SELECT * FROM catalog_refresh WHERE refresh_id = ?1').bind(refreshId).first();
  const expired = row.status === 'pending' && Date.now() - Date.parse(row.requested_at) > REFRESH_TIMEOUT_MINUTES * 60_000;
  return json({ refreshId, weekStart: row.week_start, status: expired ? 'expired' : row.status, catalogRev: row.catalog_rev,
                requestedByClass: row.requested_by_class, requestedByLabel: row.requested_by_label,
                requestedAt: row.requested_at, resolvedAt: row.resolved_at, detail: JSON.parse(row.detail || '{}'),
                isLatestForWeek: latest?.refresh_id === refreshId });
}

// ─── Earlier weeks touched by this cycle's ingests ────────────────────────────

/**
 * Draft revisions for earlier weeks whose source records changed in this
 * cycle (Shopify updated orders, late ShipStation shipments, HPD actuals).
 * Never publishes. One week per call by default (D1 query budget); returns
 * the rest in `remaining`. Idempotent: a week already revised after its last
 * touching ingest is skipped.
 */
export async function reviseTouchedWeeks(request, env) {
  const body = await readJson(request);
  const cycleWeek = mondayOrThrow(body.weekStart);
  const actor = actorFor('admin_secret', body);
  const db = env.DB;
  const runs = (await db.prepare("SELECT run_id, source, mode, finished_at, weeks_touched FROM ingest_run WHERE week_start = ?1 AND status = 'ok' ORDER BY started_at")
    .bind(cycleWeek).all()).results || [];
  const touched = new Map();                                     // week → { changed, runs:Set, lastAt }
  for (const r of runs) {
    for (const [w, n] of Object.entries(JSON.parse(r.weeks_touched || '{}'))) {
      if (!(w < cycleWeek) || !WEEK_RE.test(w)) continue;
      const t = touched.get(w) || { changed: 0, runs: new Set(), sources: new Set(), lastAt: '' };
      t.changed += Number(n) || 0; t.runs.add(r.run_id); t.sources.add(r.mode ? `${r.source}:${r.mode}` : r.source);
      if ((r.finished_at || '') > t.lastAt) t.lastAt = r.finished_at || '';
      touched.set(w, t);
    }
  }
  const todo = [], skipped = [];
  for (const [w, t] of [...touched].sort()) {
    const hasSnap = await db.prepare('SELECT 1 AS x FROM snapshot WHERE week_start = ?1 LIMIT 1').bind(w).first();
    if (!hasSnap) { skipped.push({ weekStart: w, reason: 'no_snapshot_yet', changedRecords: t.changed }); continue; }
    const done = await db.prepare("SELECT run_id FROM reporting_run WHERE week_start = ?1 AND trigger = 'source_update' AND created_at >= ?2 AND state NOT IN ('failed','cancelled') LIMIT 1")
      .bind(w, t.lastAt).first();
    if (done) { skipped.push({ weekStart: w, reason: 'already_revised', runId: done.run_id }); continue; }
    todo.push({ weekStart: w, ...t });
  }
  const maxWeeks = Math.min(Math.max(parseInt(body.maxWeeks || 1, 10), 1), 8);
  const revised = [];
  for (const t of todo.slice(0, maxWeeks)) {
    const reason = `Source update in cycle ${cycleWeek}: ${t.changed} changed record(s) from ${[...t.sources].join(', ')} (ingest ${[...t.runs].join(', ')})`;
    try {
      const r = await computeWeek(env, { weekStart: t.weekStart, trigger: 'source_update', actor, reason });
      revised.push({ ...runResult(r), reason, published: false });
    } catch (e) { revised.push({ weekStart: t.weekStart, error: e.code || 'compute_failed', message: e.message, reason }); }
  }
  return json({ cycleWeek, revised, remaining: todo.slice(maxWeeks).map(t => t.weekStart), skipped,
                note: 'Revisions are drafts. Nothing is published automatically.' });
}

export async function getRunDetail(env, runId) {
  const run = await getRun(env.DB, runId);
  const transitions = (await env.DB.prepare('SELECT * FROM run_transition WHERE run_id = ?1 ORDER BY seq').bind(runId).all()).results || [];
  return json({ run: { ...run, gate: run.gate ? JSON.parse(run.gate) : null }, transitions });
}

export async function publish(request, env) {
  const body = await readJson(request);
  if (!body.snapshotId) throw new ApiError(400, 'bad_payload', 'snapshotId is required');
  return json(await publishSnapshot(env, body.snapshotId, actorFor('admin_secret', body)));
}

export async function settings(request, env) {
  if (request.method === 'GET') return json({ settings: await getSettings(env.DB), publicationAllowedInEnvironment: env.PUBLICATION_ALLOWED === 'true' });
  const body = await readJson(request);
  const { reason = null, actorLabel: _label, actor: _legacy, ...changes } = body;
  const actor = actorFor('admin_secret', body);
  const errors = Object.entries(changes).map(([k, v]) => validateSetting(k, v)).filter(Boolean);
  if (errors.length) throw new ApiError(400, 'bad_payload', errors.join('; '));
  const needReason = Object.keys(changes).filter(k => REASON_REQUIRED.has(k));
  if (needReason.length && String(reason || '').trim().length < 5) {
    throw new ApiError(400, 'bad_payload', `Changing ${needReason.join(', ')} needs a stated reason`);
  }
  const before = await getSettings(env.DB);
  const why = reason ? String(reason).trim() : null;
  const writes = Object.entries(changes).map(([k, v]) => [k, v, why]);
  // A new store time zone is unconfirmed until confirmed IN THE SAME operation.
  if ('store_timezone' in changes && changes.store_timezone !== before.store_timezone && changes.store_timezone_confirmed !== true) {
    const i = writes.findIndex(([k]) => k === 'store_timezone_confirmed');
    if (i >= 0) writes.splice(i, 1);
    writes.push(['store_timezone_confirmed', false, `automatic: store_timezone changed to ${changes.store_timezone}; reconfirmation required`]);
  }
  const at = nowIso();
  await atomic(env.DB, writes.flatMap(([k, v, r]) => [
    env.DB.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)').bind(k, JSON.stringify(v), at),
    env.DB.prepare('INSERT INTO settings_audit (key, old_value, new_value, reason, actor_class, actor_label, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
      .bind(k, before[k] === undefined ? null : JSON.stringify(before[k]), JSON.stringify(v), r, actor.cls, actor.label, at),
  ]));
  return json({ settings: await getSettings(env.DB), ...actorJson(actor) });
}

// ─── Backfill ─────────────────────────────────────────────────────────────────

/**
 * Monthly ranges and Monday–Sunday weeks from `from` through the latest
 * COMPLETED week (its Sunday is before `today`). `from` is a parameter, so an
 * earlier start date later needs no schema or code change.
 */
export function planBackfill(from, to, today) {
  if (!WEEK_RE.test(from)) throw new ApiError(400, 'bad_payload', 'from must be YYYY-MM-DD');
  const lastCompleteSunday = addDays(weekStartOf(today), -1);
  const end = to && WEEK_RE.test(to) && to < lastCompleteSunday ? to : lastCompleteSunday;
  const weeks = [];
  for (let w = weekStartOf(from); addDays(w, 6) <= end; w = addDays(w, 7)) weeks.push(w);
  const months = [];
  for (let m = from.slice(0, 7); `${m}-01` <= end; ) {
    const [y, mo] = m.split('-').map(Number);
    const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
    months.push({ month: m, from: `${m}-01` < from ? from : `${m}-01`, to: addDays(`${next}-01`, -1) > end ? end : addDays(`${next}-01`, -1) });
    m = next;
  }
  return { from, through: end, months, weeks };
}

export async function backfill(request, env) {
  const body = await readJson(request);
  const actor = actorFor('admin_secret', body);
  const settings = await getSettings(env.DB);
  const today = body.today || businessDateOf(toStoreLocal(new Date().toISOString(), settings.store_timezone));
  const plan = planBackfill(body.from || '2026-01-01', body.to || null, today);
  const counts = new Map(((await env.DB.prepare('SELECT week_start, COUNT(*) AS n FROM shopify_order GROUP BY week_start').all()).results || [])
    .map(r => [r.week_start, r.n]));
  const snaps = new Set(((await env.DB.prepare('SELECT DISTINCT week_start FROM snapshot').all()).results || []).map(r => r.week_start));
  const weeks = plan.weeks.map(w => ({ weekStart: w, ordersIngested: counts.get(w) || 0, hasSnapshot: snaps.has(w) }));
  if (body.dryRun !== false) return json({ ...plan, weeks, dryRun: true });

  // About 35 D1 queries per week: 1 week fits the free plan's 50 per invocation;
  // on the paid plan (1,000) up to 8 weeks per call is safe.
  const maxWeeks = Math.min(Math.max(parseInt(body.maxWeeks || 1, 10), 1), 8);
  const todo = weeks.filter(w => w.ordersIngested > 0 && !w.hasSnapshot);
  const results = [];
  for (const w of todo.slice(0, maxWeeks)) {
    try { results.push(runResult(await computeWeek(env, { weekStart: w.weekStart, trigger: 'backfill', actor,
                                                          acceptCatalogReuse: body.acceptCatalogReuse || null }))); }
    catch (e) { results.push({ weekStart: w.weekStart, error: e.code || 'compute_failed', message: e.message }); }
  }
  return json({ ...plan, dryRun: false, computed: results, remaining: todo.slice(maxWeeks).map(w => w.weekStart) });
}

// ─── Go-live checks ───────────────────────────────────────────────────────────

/** Carrier Fee vs Rate comparison over stored shipments for a set of weeks. */
export async function shipstationFieldComparison(request, env) {
  const body = await readJson(request);
  const weeks = (body.weeks || []).filter(w => WEEK_RE.test(w));
  if (!weeks.length) throw new ApiError(400, 'bad_payload', 'weeks: [YYYY-MM-DD, …] is required');
  const orders = await selectIn(env.DB, 'SELECT order_number FROM shopify_order WHERE week_start IN (SELECT value FROM json_each(?1))', weeks);
  const shipments = await loadShipmentsForOrders(env.DB, [...new Set(orders.map(o => o.order_number))]);
  const comparison = compareCarrierFeeToRate(shipments);
  const insurance = body.observedTotals ? classifyInsuranceTreatment(shipments, body.observedTotals) : null;
  return json({ weeks, shipments: shipments.length, comparison, insurance,
    note: 'Lock the Carrier Fee priority only after reviewing this comparison (Revision 5).' });
}

// ─── Storage monitoring ───────────────────────────────────────────────────────

export async function storage(request, env) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM snapshot').run();
  const bytes = r?.meta?.size_after ?? null;
  const quota = Number(env.D1_QUOTA_BYTES || 5_000_000_000);
  const pct = bytes === null ? null : Math.round((bytes / quota) * 10000) / 100;
  if (bytes !== null) {
    await env.DB.prepare('INSERT OR REPLACE INTO storage_usage (measured_at, bytes_used, pct_of_quota) VALUES (?1, ?2, ?3)').bind(nowIso(), bytes, pct).run();
  }
  return json({ bytesUsed: bytes, quotaBytes: quota, pctOfQuota: pct, reviewRetention: pct !== null && pct >= 70,
    note: pct !== null && pct >= 70 ? 'D1 usage is at or above 70% of quota: review retention (Revision 5). Nothing is pruned automatically.' : null });
}

/** Recent catalog pushes and which refresh each resolved (deploy-preview acceptance, operations). */
export async function catalogPushes(request, env) {
  const url = new URL(request.url);
  const since = url.searchParams.get('since') || '1970-01-01T00:00:00Z';
  if (isNaN(Date.parse(since))) throw new ApiError(400, 'bad_query', 'since must be an ISO timestamp');
  const rows = (await env.DB.prepare(`SELECT run_id, started_at, finished_at, status, error, diagnostics FROM ingest_run
      WHERE source = 'catalog' AND started_at >= ?1 ORDER BY started_at DESC LIMIT 50`).bind(new Date(since).toISOString()).all()).results || [];
  return json({ pushes: rows.map(r => { const d = JSON.parse(r.diagnostics || '{}');
    return { ingestRunId: r.run_id, startedAt: r.started_at, finishedAt: r.finished_at, status: r.status, error: r.error,
             catalogRev: d.catalogRev || null, accepted: d.accepted ?? null, refresh: d.refresh || null }; }) });
}
