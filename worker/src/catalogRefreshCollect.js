/**
 * catalogRefreshCollect.js — the collector's weekly catalog refresh (Free tier, no Worker cron)
 * ============================================================================================
 *   POST /v1/collect/weeks/:weekStart/catalog-refresh      X-Ingest-Secret
 *
 * A week's figures need a cost catalog verified current for that week (gate: catalog_stale otherwise).
 * On the Free tier nothing requested that refresh, so every new week waited for an owner's audited
 * acceptance. The collector now asks here once per closed, unpublished week that needs it:
 *   - not_needed: the week is published (its catalog is pinned), is before PUBLICATION_EARLIEST_WEEK,
 *                 or its newest revision already used a fresh catalog;
 *   - fulfilled:  a refresh for the week was fulfilled (the next compute uses it);
 *   - pending:    a refresh is waiting for its build (nothing new is started);
 *   - requested:  a new refresh was registered and the Netlify build hook was called with
 *                 { refreshId, weekStart }; the build rebuilds the catalog from the Products Master
 *                 sheets and pushes it with that refreshId, which fulfils it (exact-id resolution);
 *   - hook_failed: the hook call failed; the refresh is closed as rejected and a later run asks again.
 * The hook URL is the Worker secret NETLIFY_BUILD_HOOK_URL (https://api.netlify.com/build_hooks/…); it is
 * never returned or logged. Repeating the call is safe: a pending refresh is reused, not duplicated.
 */
import { ApiError, json, WEEK_RE } from './http.js';
import { newId, nowIso, getSettings } from './db.js';
import { actorFor } from './actor.js';
import { REFRESH_TIMEOUT_MINUTES, FULFILLED_REFRESH_SQL, FRESH_INHERITED } from './compute.js';
import { weekWindowUtc } from '../../shared/schedule.js';

const HOOK_RE = /^https:\/\/api\.netlify\.com\/build_hooks\/[A-Za-z0-9]{8,64}$/;

export async function collectCatalogRefresh(env, weekStart, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!WEEK_RE.test(weekStart) || new Date(`${weekStart}T00:00:00Z`).getUTCDay() !== 1) throw new ApiError(400, 'bad_week', 'weekStart must be a Monday (YYYY-MM-DD)');
  const db = env.DB;
  const settings = await getSettings(db);
  const closedAt = weekWindowUtc(weekStart, settings.store_timezone).endUtcExclusive;
  if (Date.parse(closedAt) > now) return json({ weekStart, status: 'not_needed', reason: 'week_open' });
  if (env.PUBLICATION_EARLIEST_WEEK && weekStart < env.PUBLICATION_EARLIEST_WEEK) return json({ weekStart, status: 'not_needed', reason: 'before_publication_start' });

  const [pub, last, done, pending] = await db.batch([
    db.prepare("SELECT 1 AS x FROM snapshot WHERE week_start = ?1 AND status = 'published' LIMIT 1").bind(weekStart),
    db.prepare('SELECT catalog_info FROM snapshot WHERE week_start = ?1 ORDER BY revision DESC LIMIT 1').bind(weekStart),
    db.prepare(FULFILLED_REFRESH_SQL).bind(weekStart),
    db.prepare("SELECT refresh_id, requested_at FROM catalog_refresh WHERE week_start = ?1 AND status = 'pending' ORDER BY requested_at DESC LIMIT 1").bind(weekStart),
  ]);
  const first = r => (r.results || [])[0] || null;
  if (first(pub)) return json({ weekStart, status: 'not_needed', reason: 'published' });
  const f = first(done);
  if (f) return json({ weekStart, status: 'fulfilled', refreshId: f.refresh_id, catalogRev: f.catalog_rev });
  const lastInfo = (() => { try { return JSON.parse(first(last)?.catalog_info || 'null'); } catch { return null; } })();
  if (lastInfo?.freshness?.status && FRESH_INHERITED.includes(lastInfo.freshness.status)) {
    return json({ weekStart, status: 'not_needed', reason: 'catalog_current' });
  }
  const p = first(pending);
  if (p && now - Date.parse(p.requested_at) <= REFRESH_TIMEOUT_MINUTES * 60_000) return json({ weekStart, status: 'pending', refreshId: p.refresh_id });

  const hook = String(env.NETLIFY_BUILD_HOOK_URL || '').trim();
  if (!HOOK_RE.test(hook)) throw new ApiError(409, 'build_hook_unconfigured', 'NETLIFY_BUILD_HOOK_URL is not set to a Netlify build hook');
  const refreshId = newId('crf');
  const actor = actorFor('ingest_secret', { actorLabel: 'collector' });
  await db.prepare("INSERT INTO catalog_refresh (refresh_id, week_start, requested_at, requested_by_class, requested_by_label, status, detail) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6)")
    .bind(refreshId, weekStart, nowIso(), actor.cls, actor.label, JSON.stringify({ via: 'collector_build_hook' })).run();
  let httpStatus = null;
  try {
    const res = await fetchImpl(`${hook}?trigger_title=${encodeURIComponent(`SB GP catalog refresh ${weekStart}`)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshId, weekStart }) });
    httpStatus = res.status;
    if (res.ok) return json({ weekStart, status: 'requested', refreshId });
  } catch { /* network error: closed below */ }
  await db.prepare("UPDATE catalog_refresh SET status = 'rejected', resolved_at = ?2, detail = ?3 WHERE refresh_id = ?1 AND status = 'pending'")
    .bind(refreshId, nowIso(), JSON.stringify({ via: 'collector_build_hook', reasons: ['build_hook_failed'], httpStatus })).run();
  return json({ weekStart, status: 'hook_failed', refreshId, httpStatus });
}
