/**
 * orchestrate.js — C7 weekly orchestration in the Worker
 * ======================================================
 * scheduledTick(env, at)  the Cron entry point (index.js `scheduled`). Off unless
 *                         AUTOMATION_ENABLED = "true" (wrangler.toml: "false",
 *                         and no cron trigger is configured there).
 *
 * Each tick, under a compare-and-swap lease so ticks never overlap:
 *   1. The current cycle (the last closed reporting week) is attempted at its
 *      first slot, on every due retry (every 15 min to +3 h, hourly to +24 h),
 *      and whenever a source for it changed since the last attempt. Missing
 *      sources → waiting_for_sources (no snapshot); after the cutoff →
 *      source_timeout. computeScheduledWeek() owns all run and snapshot writes.
 *   2. Up to three older source_timeout cycles whose sources changed since their
 *      last attempt are retried: a later valid upload resumes the same run.
 *   3. Once the current cycle has computed, earlier weeks touched by its
 *      uploads get draft revisions (one per tick). Nothing is ever published.
 * Every step writes an automation_event with codes and counts only.
 *
 * cycleStatus()  what the dashboard and admins see: schedule, attempts, sources
 * received / missing / pending review, timeout, run state, catalog revision and
 * completeness, shipping verification. Never a path, email detail, token,
 * sheet configuration or customer datum.
 */
import { ApiError, json, readJson, WEEK_RE } from './http.js';
import { newId, nowIso, getSettings, markCyclesChanged } from './db.js';
import { actorFor } from './actor.js';
import { computeScheduledWeek, computeWeek, readiness, chooseCatalog, shippingReportBases } from './compute.js';
import { catalogMeta } from './store.js';
import { reviseTouched } from './admin.js';
import { lastClosedWeek, retryTimeline, RETRY_POLICY } from '../../shared/schedule.js';

export const CRON_ACTOR = Object.freeze({ cls: 'worker', label: 'cron' });
const LEASE = 'weekly_tick';
const LEASE_MS = 10 * 60_000;
const scheduleOf = s => ({ timeZone: s.schedule_timezone, weekday: Number(s.schedule_weekday), time: s.schedule_time });
const J = v => JSON.stringify(v ?? null);

async function event(db, weekStart, step, status, detail = {}, correlationId = null) {
  await db.prepare(`INSERT INTO automation_event (event_id, week_start, step, status, detail, correlation_id, actor_class, actor_label, at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'worker', 'cron', ?7)`).bind(newId('evt'), weekStart, step, status, J(detail), correlationId, nowIso()).run();
}

async function acquireLease(db, holder, at) {
  const r = await db.prepare(`INSERT INTO automation_lease (name, holder, acquired_at, expires_at) VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
      WHERE automation_lease.expires_at <= excluded.acquired_at`)
    .bind(LEASE, holder, at.toISOString(), new Date(at.getTime() + LEASE_MS).toISOString()).run();
  return r.meta.changes === 1;
}
async function releaseLease(db, holder) {
  await db.prepare('DELETE FROM automation_lease WHERE name = ?1 AND holder = ?2').bind(LEASE, holder).run();
}

/** Should this tick attempt the cycle? */
export function attemptDue(cycle, at, timeline) {
  const t = at.getTime();
  if (t < Date.parse(timeline.firstAttemptAt)) return false;
  if (!cycle) return true;
  const changed = !!cycle.sources_changed_at && cycle.sources_changed_at !== cycle.changes_seen_at;
  if (cycle.status === 'waiting_for_sources') return changed || !cycle.next_retry_at || t >= Date.parse(cycle.next_retry_at);
  if (cycle.status === 'source_timeout') return changed;
  if (cycle.status === 'computed') return false;
  return true;                                   // created / computing / failed: computeScheduledWeek decides (resume or in progress)
}

export async function scheduledTick(env, at = new Date()) {
  if (env.AUTOMATION_ENABLED !== 'true') return { skipped: 'automation_disabled' };
  const db = env.DB;
  const holder = newId('lse');
  if (!(await acquireLease(db, holder, at))) return { skipped: 'lease_held' };
  const out = { at: at.toISOString(), attempts: [], revisions: [] };
  try {
    const settings = await getSettings(db);
    const sched = scheduleOf(settings), tz = settings.store_timezone;
    const week = lastClosedWeek(at, tz);
    const timeline = retryTimeline(week, sched, tz);
    const attempt = async w => {
      try {
        const r = await computeScheduledWeek(env, { weekStart: w, actor: CRON_ACTOR, now: at });
        const state = r.state || r.run?.state;
        await event(db, w, 'compute', state || 'unknown', { missing: r.missing || [], existing: !!r.existing, inProgress: !!r.inProgress,
          snapshotStatus: r.status || null, nextRetryAt: r.nextRetryAt || null }, r.run?.run_id || null);
        out.attempts.push({ weekStart: w, state, missing: r.missing || [], existing: !!r.existing });
      } catch (e) {
        await event(db, w, 'compute', 'error', { code: e.code || 'error' });
        out.attempts.push({ weekStart: w, error: e.code || 'error' });
      }
    };
    const cycle = await db.prepare('SELECT * FROM schedule_cycle WHERE week_start = ?1').bind(week).first();
    if (attemptDue(cycle, at, timeline)) await attempt(week);
    else await event(db, week, 'tick', 'not_due', { status: cycle?.status || 'none', nextRetryAt: cycle?.next_retry_at || timeline.firstAttemptAt });

    const late = (await db.prepare(`SELECT week_start FROM schedule_cycle WHERE status = 'source_timeout' AND week_start <> ?1
        AND sources_changed_at IS NOT NULL AND (changes_seen_at IS NULL OR sources_changed_at <> changes_seen_at)
        ORDER BY week_start DESC LIMIT 3`).bind(week).all()).results || [];
    for (const c of late) await attempt(c.week_start);

    // C8: a week whose Shipping Cost Report basis changed since its latest
    // snapshot (a newer version accepted or rejected, a rollback) gets a new
    // draft revision first; at most one revision per tick in total.
    const basisRev = await reviseReportBasis(env, { at, tz });
    for (const v of basisRev) {
      await event(db, v.weekStart, 'revision', v.error ? 'error' : (v.state || 'draft'), { reason: 'shipping_report_basis_changed', from: v.fromSignature, to: v.toSignature, published: false });
      out.revisions.push({ weekStart: v.weekStart, state: v.state || null, error: v.error || null, basisChanged: true });
    }
    const now = await db.prepare('SELECT status FROM schedule_cycle WHERE week_start = ?1').bind(week).first();
    if (now?.status === 'computed' && !basisRev.length) {
      const r = await reviseTouched(env, { cycleWeek: week, actor: CRON_ACTOR, maxWeeks: 1 });
      for (const v of r.revised) {
        await event(db, v.weekStart, 'revision', v.error ? 'error' : (v.state || 'draft'), { cycleWeek: week, sourceHashes: v.sourceHashes || [], published: false });
        out.revisions.push({ weekStart: v.weekStart, state: v.state || null, error: v.error || null });
      }
    }
    return out;
  } finally {
    await releaseLease(db, holder);
  }
}

/**
 * C8: draft a new revision for the most recent week (within BASIS_LOOKBACK_WEEKS)
 * whose latest snapshot was computed on a different Shipping Cost Report basis
 * than the week has now — e.g. the newer version that was pending review has
 * been accepted (it now owns the dates) or rejected (the "newer pending" label
 * no longer applies). Only when the current basis is usable; never publishes.
 * A basis already attempted (same target signature) is not retried.
 */
export const BASIS_LOOKBACK_WEEKS = 12;
export async function reviseReportBasis(env, { at = new Date(), tz, maxWeeks = 1 } = {}) {
  const db = env.DB;
  const since = new Date(at.getTime() - BASIS_LOOKBACK_WEEKS * 7 * 86_400_000).toISOString().slice(0, 10);
  const latest = (await db.prepare(`SELECT s.week_start, r.gate FROM snapshot s JOIN reporting_run r ON r.run_id = s.run_id
      WHERE s.week_start >= ?1 AND s.revision = (SELECT MAX(revision) FROM snapshot x WHERE x.week_start = s.week_start)
      ORDER BY s.week_start DESC`).bind(since).all()).results || [];
  if (!latest.length) return [];
  const bases = await shippingReportBases(db, latest.map(l => l.week_start), tz, at.getTime());
  const out = [];
  for (const l of latest) {
    if (out.length >= maxWeeks) break;
    let g = {}; try { g = JSON.parse(l.gate || '{}'); } catch { g = {}; }
    const was = g.shippingReport?.signature;
    const b = bases.get(l.week_start);
    if (!was || b?.status !== 'ok' || b.signature === was) continue;          // pre-C8 records are revised by their own triggers
    const reason = `Shipping Cost Report basis changed: ${was} -> ${b.signature}`.slice(0, 500);
    const tried = await db.prepare("SELECT 1 AS x FROM reporting_run WHERE week_start = ?1 AND trigger = 'source_update' AND reason = ?2 LIMIT 1").bind(l.week_start, reason).first();
    if (tried) continue;
    try {
      const r = await computeWeek(env, { weekStart: l.week_start, trigger: 'source_update', actor: CRON_ACTOR, reason });
      out.push({ weekStart: l.week_start, state: r.run.state, snapshotId: r.snapshotId, fromSignature: was, toSignature: b.signature });
    } catch (e) { out.push({ weekStart: l.week_start, error: e.code || 'compute_failed', fromSignature: was, toSignature: b.signature }); }
  }
  return out;
}

// ─── Status ───────────────────────────────────────────────────────────────────

export async function cycleStatus(env, weekStart, { admin = false, at = new Date() } = {}) {
  const db = env.DB;
  const settings = await getSettings(db);
  const sched = scheduleOf(settings), tz = settings.store_timezone;
  const timeline = retryTimeline(weekStart, sched, tz);
  const ready = await readiness(db, weekStart, settings, { now: at.getTime() });
  const cycle = await db.prepare('SELECT * FROM schedule_cycle WHERE week_start = ?1').bind(weekStart).first();
  const run = cycle ? await db.prepare('SELECT run_id, state, snapshot_id, catalog_rev, gate FROM reporting_run WHERE run_id = ?1').bind(cycle.run_id).first() : null;
  const pendingJson = v => ({ versionId: admin ? v.versionId : undefined, sha256: v.sha256 ? v.sha256.slice(0, 16) : null,
    requestedFrom: v.requestedFrom, requestedTo: v.requestedTo, receivedAt: v.receivedAt, state: v.state });
  let snapReport = null; try { snapReport = run?.gate ? JSON.parse(run.gate).shippingReport || null : null; } catch { snapReport = null; }
  const snap = run?.snapshot_id ? await db.prepare('SELECT status, revision FROM snapshot WHERE snapshot_id = ?1').bind(run.snapshot_id).first() : null;
  const rep = ready.sources.shipping_cost_report;
  const received = Object.entries(ready.sources).filter(([, v]) => v.status === 'ok').map(([k]) => k);
  const catalogRev = run?.catalog_rev || ready.catalog.catalogRev || null;
  const meta = catalogRev ? await catalogMeta(db, catalogRev) : null;
  const comp = meta?.meta?.completeness || null;
  return {
    weekStart,
    reportingPeriod: { timeZone: tz, startUtc: ready.window.startUtc, endUtcExclusive: ready.window.endUtcExclusive, closed: ready.periodClosed },
    schedule: { collectionAt: timeline.collectionAt, firstAttemptAt: timeline.firstAttemptAt, fastRetriesUntil: timeline.fastUntil,
                cutoffAt: timeline.cutoffAt, policy: RETRY_POLICY, timeZone: sched.timeZone },
    cycle: cycle ? { status: cycle.status || 'created', attempts: cycle.attempts, lastAttemptAt: cycle.last_attempt_at || null,
                     nextRetryAt: cycle.next_retry_at || null, timedOutAt: cycle.timed_out_at || null, lastError: cycle.last_error || null,
                     ...(admin ? { runId: cycle.run_id } : {}) } : null,
    run: run ? { state: run.state, snapshotStatus: snap?.status || null, revision: snap?.revision || null } : null,
    sourceTimeout: cycle?.status === 'source_timeout',
    sources: {
      received,
      missing: ready.missing,
      pendingReview: rep?.status === 'pending_review' || rep?.newerPending?.length ? ['shipping_cost_report'] : [],
      informational: { shipstation_mapping: ready.sources.shipstation_mapping.status, hpd: ready.sources.hpd.status },
    },
    catalog: { rev: catalogRev, refreshStatus: ready.catalog.status, reuseAccepted: !!ready.catalog.reuseAccepted,
               completeness: comp ? { status: comp.status, label: comp.label, unresolvedSources: comp.unresolvedSources.length } : { status: 'unknown', label: 'Catalog completeness not recorded' } },
    // C8: the report basis — versions used (hash, period, received, state) and any newer one in review.
    shippingReport: { status: rep.status, label: rep.label || null,
      used: (rep.used || []).map(u => ({ versionId: admin ? u.versionId : undefined, sha256: u.sha256 ? u.sha256.slice(0, 16) : null, requestedFrom: u.requestedFrom,
        requestedTo: u.requestedTo, receivedAt: u.receivedAt, state: u.state, weekDatesFrom: u.weekDatesFrom, weekDatesTo: u.weekDatesTo })),
      newerPending: (rep.newerPending || []).map(pendingJson),
      pendingReview: (rep.pendingReview || []).map(pendingJson),
      snapshotUsed: snapReport ? { label: snapReport.label || null, newerPending: (snapReport.newerPending || []).length, versions: (snapReport.used || []).length } : null },
    shippingVerification: settings.shipping_cost_report_source_verified === true ? 'verified' : 'unverified',
    publication: { enabled: settings.publication_enabled === true && env.PUBLICATION_ALLOWED === 'true', automationEnabled: env.AUTOMATION_ENABLED === 'true' },
  };
}

/** GET /v1/automation/status?weekStart=  (dashboard session; admin sees the run id) */
export async function automationStatus(request, env, reader) {
  const url = new URL(request.url);
  const s = await getSettings(env.DB);
  const weekStart = url.searchParams.get('weekStart') || lastClosedWeek(new Date(), s.store_timezone);
  if (!WEEK_RE.test(weekStart)) throw new ApiError(400, 'bad_query', 'weekStart must be YYYY-MM-DD');
  return json(await cycleStatus(env, weekStart, { admin: !!reader?.admin }));
}

/**
 * POST /v1/admin/cycles/:week/accept-catalog-reuse { reason }
 * Explicit, audited approval to compute a waiting week on the pinned catalog
 * when its refresh did not succeed. The incomplete-catalog disclosure stays.
 */
export async function acceptCycleCatalogReuse(request, env, weekStart) {
  if (!WEEK_RE.test(weekStart)) throw new ApiError(400, 'bad_query', 'week must be YYYY-MM-DD');
  const body = await readJson(request);
  const reason = String(body.reason || '').trim();
  if (reason.length < 10) throw new ApiError(400, 'bad_payload', 'Accepting catalog reuse needs a reason of at least 10 characters');
  const db = env.DB;
  const cycle = await db.prepare('SELECT run_id FROM schedule_cycle WHERE week_start = ?1').bind(weekStart).first();
  if (!cycle) throw new ApiError(409, 'no_cycle', `No scheduled cycle for ${weekStart}`);
  const run = await db.prepare('SELECT state FROM reporting_run WHERE run_id = ?1').bind(cycle.run_id).first();
  if (!['created', 'waiting_for_sources', 'source_timeout', 'failed'].includes(run?.state)) throw new ApiError(409, 'not_waiting', `The cycle's run is ${run?.state}; recompute it instead`);
  const pick = await chooseCatalog(db, weekStart);
  if (!pick?.rev) throw new ApiError(409, 'no_catalog', 'There is no accepted catalog to reuse');
  const actor = actorFor('admin_secret', body);
  await db.prepare('INSERT INTO catalog_reuse_acceptance (run_id, week_start, catalog_rev, reason, actor_class, actor_label, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
    .bind(cycle.run_id, weekStart, pick.rev, reason, actor.cls, actor.label, nowIso()).run();
  await markCyclesChanged(db, [weekStart]);
  return json({ weekStart, runId: cycle.run_id, catalogRev: pick.rev, accepted: true, note: 'The run computes on its next attempt; the catalog stays labelled with its completeness.' });
}

export async function adminCycleStatus(env, weekStart) {
  if (!WEEK_RE.test(weekStart)) throw new ApiError(400, 'bad_query', 'week must be YYYY-MM-DD');
  const events = (await env.DB.prepare('SELECT step, status, detail, at FROM automation_event WHERE week_start = ?1 ORDER BY at DESC LIMIT 50').bind(weekStart).all()).results || [];
  return json({ ...(await cycleStatus(env, weekStart, { admin: true })), events: events.map(e => ({ ...e, detail: JSON.parse(e.detail || '{}') })) });
}
