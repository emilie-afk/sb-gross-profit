/**
 * workCheck.js — GET /v1/collect/work?week=YYYY-MM-DD (ingest): is any background work unfinished?
 * ==================================================================================================
 * The daily recovery start (and every repeat start of a week already marked done on the PC) asks this
 * one cheap question before doing anything else. It answers codes only:
 *   week_open | week_sources_missing | week_not_computed | verification_backlog | publication_backlog
 *   | corrections_pending | catalog_refresh_due — or nothing, and the start exits at once.
 * catalog_refresh_due: an unpublished week in the collector's window (the closed week and the 7 before it)
 * whose newest revision is on a catalog not verified current for it, when a refresh would act now (hook
 * configured, no backoff or retry limit; or a batch in flight), or its fulfilled refresh is not yet applied.
 * A week held only by the hook's backoff or limit is not work: starts during the backoff exit at once.
 * Plus the day's budget state, so a start that has work but no budget defers without trying.
 * Reads: the week's status (~100 rows) and three LIMIT 1 lookups (each filtered in SQL before its LIMIT,
 * so the backlog is never fetched).
 */
import { ApiError, json, WEEK_RE } from './http.js';
import { weekStatus } from './weekStatus.js';
import { CURRENT_ENGINE_PENDING_SQL } from './verifyRoutes.js';
import { PUBLICATION_PENDING_SQL, FRESH_INHERITED } from './compute.js';
import { CORRECTIONS_PENDING_SQL } from './collectWeeks.js';
import { budgetState } from './usage.js';
import { refreshGate } from './catalogRefreshCollect.js';
import { ENGINE_VERSION } from '../../shared/snapshot.js';

// Unpublished weeks in the window (closed week and the 7 before it, from the publication start) whose newest
// revision is on a catalog not verified current for them; with whether a refresh covering them was fulfilled
// after that revision was computed (so a week that cannot use the refresh never loops).
export const CATALOG_STALE_WEEKS_SQL = `SELECT s.week_start,
      EXISTS (SELECT 1 FROM catalog_refresh r WHERE r.status = 'fulfilled' AND r.catalog_rev IS NOT NULL AND r.resolved_at > s.computed_at
        AND (r.week_start = s.week_start OR EXISTS (SELECT 1 FROM json_each(r.detail, '$.weeks') j WHERE j.value = s.week_start))) AS fulfilled
    FROM snapshot s
    WHERE s.week_start >= ?1 AND s.week_start >= date(?2, '-49 days') AND s.week_start <= ?2 AND s.status IN ('draft', 'blocked')
      AND NOT EXISTS (SELECT 1 FROM snapshot n WHERE n.week_start = s.week_start AND n.revision > s.revision)
      AND NOT EXISTS (SELECT 1 FROM snapshot p WHERE p.week_start = s.week_start AND p.status = 'published')
      AND COALESCE(json_extract(s.catalog_info, '$.freshness.status'), '') NOT IN (${FRESH_INHERITED.map(x => `'${x}'`).join(', ')})
    ORDER BY s.week_start LIMIT 8`;

const SOURCE_CODES = new Set(['shopify_signin_required', 'shopify_export_pending', 'shipping_report_missing', 'shipping_report_partial', 'shipping_report_invalid']);

export async function workCheck(request, env) {
  const week = new URL(request.url).searchParams.get('week') || '';
  if (!WEEK_RE.test(week)) throw new ApiError(400, 'bad_query', 'week must be YYYY-MM-DD');
  const db = env.DB;
  const s = await weekStatus(db, week);
  const codes = new Set((s.pending || []).map(p => p.code));
  const unfinished = [];
  if (codes.has('week_open')) unfinished.push('week_open');
  else if ([...codes].some(c => SOURCE_CODES.has(c))) unfinished.push('week_sources_missing');
  else if (codes.has('compute_pending') || codes.has('verification_pending') || codes.has('verification_unavailable')) unfinished.push('week_not_computed');
  const earliest = /^\d{4}-\d{2}-\d{2}$/.test(env.PUBLICATION_EARLIEST_WEEK || '') ? env.PUBLICATION_EARLIEST_WEEK : '0000-00-00';
  const [v, p, c, st] = await db.batch([
    db.prepare(CURRENT_ENGINE_PENDING_SQL).bind(ENGINE_VERSION),
    db.prepare(PUBLICATION_PENDING_SQL).bind('0000-00-00', 1, earliest),
    db.prepare(CORRECTIONS_PENDING_SQL).bind('0000-00-00', 1),
    db.prepare(CATALOG_STALE_WEEKS_SQL).bind(earliest, week),
  ]);
  if ((v.results || []).length) unfinished.push('verification_backlog');
  if ((p.results || []).length) unfinished.push('publication_backlog');
  if ((c.results || []).length) unfinished.push('corrections_pending');
  const staleWeeks = st.results || [];
  if (staleWeeks.length && !unfinished.includes('week_open')) {
    // A fulfilled refresh not yet applied always needs the recompute; otherwise only when a request would act.
    const due = staleWeeks.some(r => r.fulfilled) || ['ok', 'pending'].includes((await refreshGate(env)).state);
    if (due) unfinished.push('catalog_refresh_due');
  }
  let budget;
  try { const b = await budgetState(env, db); budget = { state: b.state, reasons: b.reasons, resetAt: b.resetAt }; }
  catch { budget = { state: 'unknown', reasons: ['budget_unavailable'] }; }
  return json({ week, unfinished, budget });
}
