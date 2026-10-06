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
  shipping_report_invalid: 'Shipping Cost Report failed automated checks; it is re-exported on the next attempt',
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
  // The newest automatically rejected version covering the week (failed automated checks), if any.
  const bad = await db.prepare(`SELECT version_id, imported_at, json_extract(outcome, '$.invalidReasons') AS reasons FROM scr_version
      WHERE status = 'rejected' AND requested_from <= ?2 AND requested_to >= ?1 AND json_extract(outcome, '$.automatic') = 1 ORDER BY imported_at DESC LIMIT 1`).bind(weekStart, weekEnd).first();
  if (basis.basisStatus !== 'ok') pending.push(basis.basisStatus === 'pending_review' ? 'shipping_report_pending_review' : basis.basisStatus === 'partial' ? 'shipping_report_partial'
    : bad ? 'shipping_report_invalid' : 'shipping_report_missing');
  else if (basis.newerPending.length) pending.push('shipping_report_newer_pending');
  // Flags, shown and never a reason to wait: the version-level flags of the accepted versions the week
  // uses, plus every automatic version's late corrections and omitted (kept) costs that concern this
  // week, also when that version owns none of the week's dates (a report that only omitted a cost).
  const usedIds = [...new Set((basis.used || []).map(u => u.versionId))];
  const flagRows = (await db.prepare(`SELECT version_id, json_extract(outcome, '$.flags') AS flags, json_extract(outcome, '$.changedDates') AS changed,
        json_extract(outcome, '$.omittedDates') AS omitted, json_extract(outcome, '$.changedWeeks') AS cw, json_extract(outcome, '$.omittedWeeks') AS ow
      FROM scr_version WHERE version_id IN (SELECT value FROM json_each(?1))
         OR (json_extract(outcome, '$.automatic') = 1 AND status <> 'rejected' AND (
             EXISTS (SELECT 1 FROM json_each(scr_version.outcome, '$.changedWeeks') j WHERE j.value = ?2)
          OR EXISTS (SELECT 1 FROM json_each(scr_version.outcome, '$.omittedWeeks') j WHERE j.value = ?2)))`)
    .bind(JSON.stringify(usedIds), weekStart).all()).results || [];
  const P = t => { try { return JSON.parse(t || '[]') || []; } catch { return []; } };
  const concerns = (r, k) => P(r[k]).includes(weekStart);
  const reportFlags = [...new Set(flagRows.flatMap(r => [
    ...(usedIds.includes(r.version_id) ? P(r.flags).filter(f => f !== 'changed_cost' && f !== 'accepted_cost_removed') : []),
    ...(concerns(r, 'cw') || (usedIds.includes(r.version_id) && P(r.changed).some(d => d >= weekStart && d <= weekEnd)) ? ['changed_cost'] : []),
    ...(concerns(r, 'ow') ? ['accepted_cost_removed'] : []),
  ]))].sort();
  const inWeek = d => d >= weekStart && d <= weekEnd;
  const changedDates = [...new Set(flagRows.filter(r => concerns(r, 'cw') || usedIds.includes(r.version_id)).flatMap(r => P(r.changed)))].filter(inWeek).sort();
  const omittedDates = [...new Set(flagRows.filter(r => concerns(r, 'ow')).flatMap(r => P(r.omitted)))].filter(inWeek).sort();
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
  const published = verified && snap?.status === 'published';
  const target = verified ? (v.at <= due ? 'met' : 'met_late') : (now.toISOString() > due ? 'missed' : 'pending');
  return {
    weekStart, dueAt: due, target, state: verified ? 'verified' : pending[0],
    label: published ? 'Verified and published (provisional)' : verified ? 'Verified draft (not published)' : PENDING_LABELS[pending[0]],
    pending: pending.map(code => ({ code, label: PENDING_LABELS[code] })),
    sources: { shopifyReceivedAt: shop?.sealed_at || null,
               shippingReport: { status: basis.basisStatus, label: basis.label || null, newerPending: (basis.newerPending || []).length,
                                 flags: reportFlags, changedDates, omittedDates,
                                 ...(bad && basis.basisStatus !== 'ok' ? { invalid: { versionId: bad.version_id, at: bad.imported_at, reasons: P(bad.reasons) } } : {}) } },
    draft: snap ? { snapshotId: snap.snapshot_id, revision: snap.revision, status: snap.status, computedAt: snap.computed_at } : null,
    verification: v ? { status: v.status, at: v.at, attempts: v.attempts, counts: { ordersChecked: v.report.ordersChecked ?? null,
      orderMismatches: v.report.orderMismatches ?? null, sectionMismatches: v.report.sectionMismatches ?? null } } : null,
  };
}

export async function getWeekStatus(env, weekStart) {
  if (!WEEK_RE.test(weekStart)) throw new ApiError(400, 'bad_query', 'week must be YYYY-MM-DD');
  return json(await weekStatus(env.DB, weekStart));
}

/**
 * GET /v1/collect/verification?ids=snp_…,snp_… (ingest, ≤ 16 ids): the verification status of the
 * drafts the collector is waiting for, in ONE light query. The collector polls this instead of
 * every week's full status (8 requests every 15 s while the verifier is loading the Worker).
 * `superseded`: a newer revision of that week exists.
 */
export async function verificationStatuses(request, env) {
  const ids = (new URL(request.url).searchParams.get('ids') || '').split(',').filter(Boolean);
  if (!ids.length || ids.length > 16 || ids.some(id => !/^snp_[0-9a-f]{20}$/.test(id))) throw new ApiError(400, 'bad_query', 'ids: 1–16 snapshot ids');
  const rows = (await env.DB.prepare(`SELECT s.snapshot_id, v.status, v.at,
      EXISTS (SELECT 1 FROM snapshot n WHERE n.week_start = s.week_start AND n.storage = 'chunked' AND n.revision > s.revision) AS superseded
    FROM snapshot s LEFT JOIN verify_report v ON v.snapshot_id = s.snapshot_id WHERE s.snapshot_id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(ids)).all()).results || [];
  const by = new Map(rows.map(r => [r.snapshot_id, r]));
  return json({ snapshots: ids.map(id => { const r = by.get(id); return r ? { snapshotId: id, verification: r.status || null, at: r.at || null, superseded: !!r.superseded } : { snapshotId: id, unknown: true }; }) });
}
