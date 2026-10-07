/**
 * workCheck.js — GET /v1/collect/work?week=YYYY-MM-DD (ingest): is any background work unfinished?
 * ==================================================================================================
 * The daily recovery start (and every repeat start of a week already marked done on the PC) asks this
 * one cheap question before doing anything else. It answers codes only:
 *   week_open | week_sources_missing | week_not_computed | verification_backlog | publication_backlog
 *   | corrections_pending — or nothing, and the start exits at once.
 * Plus the day's budget state, so a start that has work but no budget defers without trying.
 * Reads: the week's status (~100 rows) and three LIMIT 1 lookups (each filtered in SQL before its LIMIT,
 * so the backlog is never fetched).
 */
import { ApiError, json, WEEK_RE } from './http.js';
import { weekStatus } from './weekStatus.js';
import { CURRENT_ENGINE_PENDING_SQL } from './verifyRoutes.js';
import { PUBLICATION_PENDING_SQL } from './compute.js';
import { CORRECTIONS_PENDING_SQL } from './collectWeeks.js';
import { budgetState } from './usage.js';
import { ENGINE_VERSION } from '../../shared/snapshot.js';

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
  const [v, p, c] = await db.batch([
    db.prepare(CURRENT_ENGINE_PENDING_SQL).bind(ENGINE_VERSION),
    db.prepare(PUBLICATION_PENDING_SQL).bind('0000-00-00', 1, earliest),
    db.prepare(CORRECTIONS_PENDING_SQL).bind('0000-00-00', 1),
  ]);
  if ((v.results || []).length) unfinished.push('verification_backlog');
  if ((p.results || []).length) unfinished.push('publication_backlog');
  if ((c.results || []).length) unfinished.push('corrections_pending');
  let budget;
  try { const b = await budgetState(env, db); budget = { state: b.state, reasons: b.reasons, resetAt: b.resetAt }; }
  catch { budget = { state: 'unknown', reasons: ['budget_unavailable'] }; }
  return json({ week, unfinished, budget });
}
