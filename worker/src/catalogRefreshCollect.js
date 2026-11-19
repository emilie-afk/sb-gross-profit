/**
 * catalogRefreshCollect.js — the collector's weekly catalog refresh (Free tier, no Worker cron)
 * ============================================================================================
 *   POST /v1/collect/catalog-refresh            { weeks: [...] }   X-Ingest-Secret   (may start ONE build)
 *   GET  /v1/collect/catalog-refresh/:refreshId                    X-Ingest-Secret   (status only, never a build)
 *
 * A week's figures need a cost catalog verified current for that week (gate: catalog_stale otherwise).
 * On the Free tier nothing requested that refresh, so every new week waited for an owner's audited
 * acceptance. The collector now asks once per run for all the weeks it is about to compute:
 *
 *   - Weeks that need nothing (published: their catalog is pinned; still open; before
 *     PUBLICATION_EARLIEST_WEEK; newest revision already fresh; covered by a fulfilled refresh) are
 *     answered without any write.
 *   - Every remaining week goes into ONE batch refresh (one catalog_refresh row; its weeks in
 *     detail.weeks) answered by ONE Netlify build: the hook body is { refreshId, weekStart }, the build
 *     rebuilds the catalog from the sheets and pushes it with that id, and fulfilling the row makes the
 *     catalog current for every week in the batch (the build started after they closed).
 *   - At most one collector build is in flight: the row is inserted by a single INSERT … SELECT … WHERE
 *     NOT EXISTS (in-flight refresh) statement, so two simultaneous requests cannot both start a build.
 *     Weeks that miss an in-flight batch are reported 'queued' and go into the next batch.
 *   - An in-flight refresh older than REFRESH_TIMEOUT_MINUTES (a cancelled or stuck build) is closed as
 *     'expired' before a new one is claimed, so no refresh stays unresolved; a build that arrives later
 *     resolves nothing (exact-id resolution, unchanged).
 *   - Failed hook calls back off (persisted in the rejected rows: 15 min × 2^(n−1), at most 6 h) and stop
 *     after HOOK_FAILURE_LIMIT failures within 24 h ('retry_limit') until the oldest of them is a day old;
 *     a successful call clears the count.
 *   - The hook call has its own timeout (HOOK_TIMEOUT_MS).
 * The hook URL is the Worker secret NETLIFY_BUILD_HOOK_URL (https://api.netlify.com/build_hooks/…); it is
 * never returned or logged. Publication gates and pinned catalogs are untouched: this only supplies the
 * week_refresh basis a week's catalog check already accepts.
 */
import { ApiError, json, readJson, WEEK_RE } from './http.js';
import { newId, nowIso, getSettings } from './db.js';
import { actorFor } from './actor.js';
import { REFRESH_TIMEOUT_MINUTES, FRESH_INHERITED, FULFILLED_REFRESH_SQL } from './compute.js';
import { REFRESH_ID_RE } from './ingest.js';
import { weekWindowUtc } from '../../shared/schedule.js';

const HOOK_RE = /^https:\/\/api\.netlify\.com\/build_hooks\/[A-Za-z0-9]{8,64}$/;
export const VIA = 'collector_build_hook';
export const HOOK_TIMEOUT_MS = 15_000;
export const HOOK_FAILURE_LIMIT = 5;                         // per 24 h
export const HOOK_BACKOFF_BASE_MS = 15 * 60_000;
export const HOOK_BACKOFF_MAX_MS = 6 * 60 * 60_000;
export const MAX_BATCH_WEEKS = 26;
const DAY_MS = 24 * 60 * 60_000;
const timeoutMs = () => REFRESH_TIMEOUT_MINUTES * 60_000;

const INFLIGHT_WHERE = `status = 'pending' AND json_extract(detail, '$.via') = '${VIA}' AND requested_at > ?1`;

const isMonday = w => WEEK_RE.test(w) && new Date(`${w}T00:00:00Z`).getUTCDay() === 1;
const first = r => (r?.results || [])[0] || null;
const parse = s => { try { return JSON.parse(s || 'null'); } catch { return null; } };

/** Backoff after n failed hook calls (n ≥ 1). */
export const backoffMs = n => Math.min(HOOK_BACKOFF_BASE_MS * 2 ** Math.max(0, n - 1), HOOK_BACKOFF_MAX_MS);

/** Which of the weeks need a refresh, and why the others do not. Reads only. */
async function classify(env, weeks, now) {
  const db = env.DB;
  const settings = await getSettings(db);
  const out = {}, need = [];
  const candidates = [];
  for (const w of weeks) {
    if (Date.parse(weekWindowUtc(w, settings.store_timezone).endUtcExclusive) > now) out[w] = { status: 'not_needed', reason: 'week_open' };
    else if (env.PUBLICATION_EARLIEST_WEEK && w < env.PUBLICATION_EARLIEST_WEEK) out[w] = { status: 'not_needed', reason: 'before_publication_start' };
    else candidates.push(w);
  }
  if (!candidates.length) return { out, need };
  const rs = await db.batch(candidates.flatMap(w => [
    db.prepare("SELECT 1 AS x FROM snapshot WHERE week_start = ?1 AND status = 'published' LIMIT 1").bind(w),
    db.prepare('SELECT catalog_info FROM snapshot WHERE week_start = ?1 ORDER BY revision DESC LIMIT 1').bind(w),
    db.prepare(FULFILLED_REFRESH_SQL).bind(w),
  ]));
  candidates.forEach((w, i) => {
    const [pub, last, done] = rs.slice(i * 3, i * 3 + 3).map(first);
    const fresh = parse(last?.catalog_info)?.freshness?.status;
    if (pub) out[w] = { status: 'not_needed', reason: 'published' };
    else if (done) out[w] = { status: 'fulfilled', refreshId: done.refresh_id, catalogRev: done.catalog_rev };
    else if (fresh && FRESH_INHERITED.includes(fresh)) out[w] = { status: 'not_needed', reason: 'catalog_current' };
    else need.push(w);
  });
  return { out, need };
}

/** Failed hook calls in the last 24 h since the last successful one (persisted in the rejected rows). */
async function hookFailures(db, now) {
  const since = new Date(now - DAY_MS).toISOString();
  return first(await db.prepare(`SELECT COUNT(*) AS n, MAX(resolved_at) AS last FROM catalog_refresh
      WHERE status = 'rejected' AND json_extract(detail, '$.via') = '${VIA}' AND json_extract(detail, '$.hookFailed') = 1 AND resolved_at > ?1
        AND resolved_at > COALESCE((SELECT MAX(requested_at) FROM catalog_refresh WHERE json_extract(detail, '$.via') = '${VIA}' AND json_extract(detail, '$.hookOk') = 1), '')`)
    .bind(since).all()) || { n: 0, last: null };
}

/**
 * Would a refresh request act now? Reads only (used by the recovery work check):
 *   'ok' (a build can be requested) | 'pending' (a collector build is in flight) | 'backoff' | 'retry_limit' | 'unconfigured'.
 */
export async function refreshGate(env, { now = Date.now() } = {}) {
  const db = env.DB;
  const cutoff = new Date(now - timeoutMs()).toISOString();
  if (first(await db.prepare(`SELECT 1 AS x FROM catalog_refresh WHERE ${INFLIGHT_WHERE} LIMIT 1`).bind(cutoff).all())) return { state: 'pending' };
  const f = await hookFailures(db, now);
  if (f.n >= HOOK_FAILURE_LIMIT) return { state: 'retry_limit' };
  const notBefore = f.n ? Date.parse(f.last) + backoffMs(f.n) : 0;
  if (notBefore > now) return { state: 'backoff', retryAfter: new Date(notBefore).toISOString() };
  if (!HOOK_RE.test(String(env.NETLIFY_BUILD_HOOK_URL || '').trim())) return { state: 'unconfigured' };
  return { state: 'ok' };
}

export async function requestCatalogRefresh(request, env, { fetchImpl = fetch, now = Date.now(), hookTimeoutMs = HOOK_TIMEOUT_MS } = {}) {
  const body = await readJson(request);
  const weeks = [...new Set(Array.isArray(body?.weeks) ? body.weeks : [])];
  if (!weeks.length || weeks.length > MAX_BATCH_WEEKS || !weeks.every(isMonday)) {
    throw new ApiError(400, 'bad_payload', `weeks must be 1–${MAX_BATCH_WEEKS} Mondays (YYYY-MM-DD)`);
  }
  weeks.sort();
  const db = env.DB;
  const { out, need } = await classify(env, weeks, now);
  const answer = extra => json({ weeks: out, ...extra });
  if (!need.length) return answer({ status: 'not_needed' });

  const cutoff = new Date(now - timeoutMs()).toISOString();
  // A collector build that never answered (cancelled, stuck): closed, so nothing stays unresolved.
  await db.prepare(`UPDATE catalog_refresh SET status = 'expired', resolved_at = ?2,
      detail = json_set(detail, '$.note', 'no build answered within ${REFRESH_TIMEOUT_MINUTES} minutes')
      WHERE status = 'pending' AND json_extract(detail, '$.via') = '${VIA}' AND requested_at <= ?1`).bind(cutoff, nowIso()).run();

  const inflightOf = async () => first(await db.prepare(`SELECT refresh_id, detail FROM catalog_refresh WHERE ${INFLIGHT_WHERE} ORDER BY requested_at DESC LIMIT 1`).bind(cutoff).all());
  const reportInflight = row => {
    const covered = new Set(parse(row.detail)?.weeks || []);
    for (const w of need) out[w] = covered.has(w) ? { status: 'pending', refreshId: row.refresh_id } : { status: 'queued', refreshId: row.refresh_id };
    return answer({ status: 'pending', refreshId: row.refresh_id });
  };
  const inflight = await inflightOf();
  if (inflight) return reportInflight(inflight);

  // Failed hook calls in the last 24 h (persisted in the rejected rows): backoff and limit.
  const f = await hookFailures(db, now);
  if (f.n >= HOOK_FAILURE_LIMIT) {
    for (const w of need) out[w] = { status: 'retry_limit' };
    return answer({ status: 'retry_limit', failures: f.n });
  }
  const notBefore = f.n ? Date.parse(f.last) + backoffMs(f.n) : 0;
  if (notBefore > now) {
    const retryAfter = new Date(notBefore).toISOString();
    for (const w of need) out[w] = { status: 'backoff', retryAfter };
    return answer({ status: 'backoff', retryAfter, failures: f.n });
  }

  const hook = String(env.NETLIFY_BUILD_HOOK_URL || '').trim();
  if (!HOOK_RE.test(hook)) throw new ApiError(409, 'build_hook_unconfigured', 'NETLIFY_BUILD_HOOK_URL is not set to a Netlify build hook');
  // The claim: one statement inserts the batch only while no collector build is in flight.
  const refreshId = newId('crf');
  const actor = actorFor('ingest_secret', { actorLabel: 'collector' });
  const claimed = await db.prepare(`INSERT INTO catalog_refresh (refresh_id, week_start, requested_at, requested_by_class, requested_by_label, status, detail)
      SELECT ?2, ?3, ?4, ?5, ?6, 'pending', ?7 WHERE NOT EXISTS (SELECT 1 FROM catalog_refresh WHERE ${INFLIGHT_WHERE}) RETURNING refresh_id`)
    .bind(cutoff, refreshId, need[need.length - 1], nowIso(), actor.cls, actor.label, JSON.stringify({ via: VIA, weeks: need })).all();
  if (!(claimed.results || []).length) {
    const other = await inflightOf();
    if (other) return reportInflight(other);
    throw new ApiError(409, 'refresh_claim_lost', 'Another request claimed the refresh; ask again');
  }

  let httpStatus = null, failure = 'build_hook_failed';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), hookTimeoutMs);
  try {
    const res = await fetchImpl(`${hook}?trigger_title=${encodeURIComponent(`SB GP catalog refresh ${need.join(' ')}`)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshId, weekStart: need[need.length - 1] }), signal: ctrl.signal });
    httpStatus = res.status;
    if (res.ok) {
      await db.prepare("UPDATE catalog_refresh SET detail = json_set(detail, '$.hookOk', 1) WHERE refresh_id = ?1").bind(refreshId).run();
      for (const w of need) out[w] = { status: 'requested', refreshId };
      return answer({ status: 'requested', refreshId });
    }
  } catch (e) {
    if (e?.name === 'AbortError') failure = 'build_hook_timeout';
  } finally { clearTimeout(timer); }
  await db.prepare(`UPDATE catalog_refresh SET status = 'rejected', resolved_at = ?2,
      detail = json_set(detail, '$.hookFailed', 1, '$.reasons', json_array(?3), '$.httpStatus', ?4) WHERE refresh_id = ?1 AND status = 'pending'`)
    .bind(refreshId, nowIso(), failure, httpStatus).run();
  const retryAfter = new Date(now + backoffMs(f.n + 1)).toISOString();
  for (const w of need) out[w] = { status: 'hook_failed', retryAfter };
  return answer({ status: 'hook_failed', refreshId, reason: failure, httpStatus, retryAfter });
}

/** Status of one refresh; never starts a build or writes anything. */
export async function catalogRefreshStatus(env, refreshId, { now = Date.now() } = {}) {
  if (!REFRESH_ID_RE.test(refreshId)) throw new ApiError(400, 'bad_refresh_id', 'refreshId is malformed');
  const r = first(await env.DB.prepare('SELECT refresh_id, week_start, status, catalog_rev, requested_at, resolved_at, detail FROM catalog_refresh WHERE refresh_id = ?1').bind(refreshId).all());
  if (!r) throw new ApiError(404, 'refresh_unknown', `No catalog refresh ${refreshId}`);
  const d = parse(r.detail) || {};
  const status = r.status === 'pending' && now - Date.parse(r.requested_at) > timeoutMs() ? 'expired' : r.status;
  return json({ refreshId, status, weeks: d.weeks || [r.week_start], catalogRev: r.catalog_rev, requestedAt: r.requested_at, resolvedAt: r.resolved_at });
}
