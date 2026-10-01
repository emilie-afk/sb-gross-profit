/**
 * weekStatus.js — exact pending status of a week on the Free-tier path
 * ====================================================================
 * GET /v1/weeks/:week/status   (session or admin)   codes, labels and timestamps only
 *
 * Target (owner decision 2026-09-29): a VERIFIED draft by the scheduled slot
 * (Monday 15:30 ICT after the week closes). The status never claims the target
 * was met unless the verifier's `verified` report is timestamped before it; when
 * an export, the Shipping Cost Report review, the compute or the verification is
 * late, it names exactly which.
 */
import { ApiError, json, WEEK_RE } from './http.js';
import { getSettings } from './db.js';
import { scrBasis } from './collectScr.js';
import { verificationOf } from './verifyRoutes.js';
import { addDays } from '../../shared/normalized.js';
import { weekWindowUtc, scheduledRunFor } from '../../shared/schedule.js';

export const PENDING_LABELS = Object.freeze({
  week_open: 'Reporting week not closed yet',
  shopify_export_pending: 'Shopify rolling export not received yet',
  shipping_report_missing: 'Shipping Cost Report not received for this week',
  shipping_report_partial: 'Shipping Cost Report does not cover the whole week yet',
  shipping_report_pending_review: 'Shipping Cost Report held for review',
  shipping_report_newer_pending: 'A newer Shipping Cost Report is held for review',
  compute_pending: 'Sources received; the draft has not been computed yet',
  verification_pending: 'Draft computed; independent verification not finished',
  verification_unavailable: 'Verification could not run yet; it will be retried',
  verification_mismatch: 'Verification found differences; the draft stays provisional',
});

export async function weekStatus(db, weekStart, now = new Date()) {
  const s = await getSettings(db);
  const tz = s.store_timezone;
  const win = weekWindowUtc(weekStart, tz);
  const due = scheduledRunFor(weekStart, { timeZone: s.schedule_timezone, weekday: s.schedule_weekday, time: s.schedule_time }, tz).toISOString();
  const weekEnd = addDays(weekStart, 6);
  const pending = [];
  if (now.toISOString() < win.endUtcExclusive) pending.push('week_open');
  const shop = await db.prepare(`SELECT source_id, sealed_at, declared FROM src_object WHERE kind = 'shopify' AND status = 'retained'
      AND json_extract(declared, '$.window.to') >= ?1 AND json_extract(declared, '$.window.from') <= ?2 ORDER BY sealed_at DESC LIMIT 1`).bind(weekEnd, weekStart).first();
  const shopifyAfterClose = shop && shop.sealed_at >= win.endUtcExclusive;
  if (!shopifyAfterClose) pending.push('shopify_export_pending');
  const basis = await scrBasis(db, weekStart, win.endUtcExclusive);
  if (basis.basisStatus !== 'ok') pending.push(basis.basisStatus === 'pending_review' ? 'shipping_report_pending_review' : basis.basisStatus === 'partial' ? 'shipping_report_partial' : 'shipping_report_missing');
  else if (basis.newerPending.length) pending.push('shipping_report_newer_pending');
  const snap = await db.prepare("SELECT snapshot_id, revision, status, computed_at FROM snapshot WHERE week_start = ?1 AND storage = 'chunked' ORDER BY revision DESC LIMIT 1").bind(weekStart).first();
  // A review decision (accept, reject, rollback) changes the week's inputs too, e.g. rejecting held
  // dates removes the "newer report pending" block, which only a new draft revision reflects.
  const decided = (await db.prepare('SELECT MAX(at) AS at FROM scr_decision WHERE EXISTS (SELECT 1 FROM json_each(scr_decision.weeks) j WHERE j.value = ?1)').bind(weekStart).first())?.at || null;
  const inputsAt = [shop?.sealed_at, decided, ...(basis.used || []).map(u => u.receivedAt)].filter(Boolean).sort().pop() || null;
  const v = snap ? (await verificationOf(db, [snap.snapshot_id])).get(snap.snapshot_id) : null;
  if (!pending.length) {
    if (!snap || (inputsAt && snap.computed_at < inputsAt)) pending.push('compute_pending');
    else if (!v) pending.push('verification_pending');
    else if (v.status === 'unavailable') pending.push('verification_unavailable');
    else if (v.status === 'mismatch') pending.push('verification_mismatch');
  }
  const verified = !pending.length && v?.status === 'verified';
  const target = verified ? (v.at <= due ? 'met' : 'met_late') : (now.toISOString() > due ? 'missed' : 'pending');
  return {
    weekStart, dueAt: due, target, state: verified ? 'verified' : pending[0],
    label: verified ? 'Verified draft (not published)' : PENDING_LABELS[pending[0]],
    pending: pending.map(code => ({ code, label: PENDING_LABELS[code] })),
    sources: { shopifyReceivedAt: shop?.sealed_at || null,
               shippingReport: { status: basis.basisStatus, label: basis.label || null, newerPending: (basis.newerPending || []).length } },
    draft: snap ? { snapshotId: snap.snapshot_id, revision: snap.revision, status: snap.status, computedAt: snap.computed_at } : null,
    verification: v ? { status: v.status, at: v.at, attempts: v.attempts, counts: { ordersChecked: v.report.ordersChecked ?? null,
      orderMismatches: v.report.orderMismatches ?? null, sectionMismatches: v.report.sectionMismatches ?? null } } : null,
  };
}

export async function getWeekStatus(env, weekStart) {
  if (!WEEK_RE.test(weekStart)) throw new ApiError(400, 'bad_query', 'week must be YYYY-MM-DD');
  return json(await weekStatus(env.DB, weekStart));
}
