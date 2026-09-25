/**
 * compute.js — build, store and gate one weekly snapshot
 * ======================================================
 * The Worker is the only writer of snapshots. Each compute writes a NEW
 * revision; nothing already written is ever updated except a published
 * revision's status, which becomes `superseded` when a later one is published.
 */
import { ApiError } from './http.js';
import { newId, nowIso, getSettings, jsonInsert, atomic } from './db.js';
import { loadOrdersForWeek, loadShipmentsForOrders, loadHpdForOrders, loadCatalog, latestAcceptedCatalogMeta, catalogMeta } from './store.js';
import { createRun, createRunStatements, getRun, transition, ownsCycle } from './runs.js';
import { WORKER } from './actor.js';
import { buildSnapshot, ENGINE_VERSION, SHIPPING_SOURCES } from '../../shared/snapshot.js';
import { effectiveOrderTotals, activeSegments } from './shippingCost.js';
import { selectIn } from './db.js';
import { evaluateGate, canPublish } from '../../shared/gate.js';
import { addDays } from '../../shared/normalized.js';
import { weekWindowUtc, scheduledRunFor } from '../../shared/schedule.js';

const J = v => JSON.stringify(v ?? null);

/**
 * C3: the week's Shipping Cost Report view. `byOrder` holds the active cost of
 * the week's orders; `covers` is true once active segments reach the week's
 * last day; `unmatched` counts report orders first shipped in the week that
 * match no ingested Shopify order.
 */
export async function reportForWeek(db, weekStart, orders) {
  const all = await effectiveOrderTotals(db);
  const keys = new Set(orders.map(o => String(o.orderNumber || '').replace(/^#/, '')));
  const byOrder = new Map([...all].filter(([k]) => keys.has(k)));
  const segs = await activeSegments(db);
  const weekEnd = addDays(weekStart, 6);
  const covers = segs.length > 0 && segs[0].segFrom <= weekStart && segs[segs.length - 1].segTo >= weekEnd;
  const shippedInWeek = [...all.values()].filter(a => a.firstShipDate >= weekStart && a.firstShipDate <= weekEnd && !keys.has(a.orderKey)).map(a => a.orderKey);
  const known = new Set((await selectIn(db, 'SELECT order_number FROM shopify_order WHERE order_number IN (SELECT value FROM json_each(?1))', shippedInWeek)).map(r => r.order_number));
  const unmatchedKeys = shippedInWeek.filter(k => !known.has(k));
  const unmatched = { orders: unmatchedKeys.length, costCents: unmatchedKeys.reduce((s, k) => s + (all.get(k)?.costCents || 0), 0) };
  const last = await db.prepare(`SELECT t.shipping_expense AS e FROM snapshot s JOIN snapshot_totals t ON t.snapshot_id = s.snapshot_id
    WHERE s.week_start = ?1 ORDER BY s.revision DESC LIMIT 1`).bind(weekStart).first();
  return { byOrder, covers, unmatched, previousShippingExpense: last ? last.e : null };
}

export async function sourceStatus(db, weekStart, { orders, shipments, hpd }) {
  const out = {};
  const present = { shopify: orders.length > 0, shipstation: shipments.length > 0, hpd: hpd.length > 0 };
  for (const source of ['shopify', 'shipstation', 'hpd']) {
    const r = await db.prepare('SELECT status FROM ingest_run WHERE source = ?1 AND week_start = ?2 ORDER BY started_at DESC LIMIT 1')
      .bind(source, weekStart).first();
    out[source] = r ? (r.status === 'ok' ? 'ok' : r.status === 'failed' ? 'failed' : 'pending')
                    : (present[source] ? 'ok' : 'pending');
  }
  return out;
}

/**
 * The prior week for comparisons. `published` is the ONLY basis the stored
 * narrative may use. `draft` (latest unpublished revision newer than the
 * published one) feeds an admin-only preview and is never history.
 */
export async function previousWeekSnapshots(db, weekStart) {
  const prevWeek = addDays(weekStart, -7);
  const base = `SELECT s.snapshot_id, s.week_start, s.status, s.revision, t.* FROM snapshot s
    JOIN snapshot_totals t ON t.snapshot_id = s.snapshot_id WHERE s.week_start = ?1`;
  const pub = await db.prepare(`${base} AND s.status = 'published'`).bind(prevWeek).first();
  const draft = await db.prepare(`${base} AND s.status IN ('draft','blocked') AND s.revision > ?2 ORDER BY s.revision DESC LIMIT 1`)
    .bind(prevWeek, pub ? pub.revision : 0).first();
  const shape = r => r ? { weekStart: r.week_start, snapshotId: r.snapshot_id, status: r.status, totals: totalsFromRow(r) } : null;
  return { published: shape(pub), draft: shape(draft) };
}

export function totalsFromRow(t) {
  return {
    operatingRevenue: t.operating_revenue, shopifyNetRevenueInclPassThrough: t.shopify_net_revenue_incl_pass_through,
    operatingGpAfterShipping: t.operating_gp_after_shipping, operatingGpMargin: t.operating_gp_margin,
    routeCollected: t.route_collected, routeRemitted: t.route_remitted, routeNet: t.route_net,
    knownProductCogs: t.known_product_cogs, knownCostProductRevenue: t.known_cost_product_revenue,
    knownCostProductGp: t.known_cost_product_gp, knownCostProductMargin: t.known_cost_product_margin,
    missingCostRevenue: t.missing_cost_revenue, missingCostUnits: t.missing_cost_units, missingCostLines: t.missing_cost_lines,
    costCoverageByRevenue: t.cost_coverage_by_revenue, costCoverageByUnits: t.cost_coverage_by_units,
    shippingCollected: t.shipping_collected, shippingExpense: t.shipping_expense,
    shipStationExpense: t.shipstation_expense, hpdShippingExpense: t.hpd_shipping_expense,
    ordersRequiringShipStationRate: t.orders_requiring_shipstation_rate, ordersWithValidShipStationRate: t.orders_with_valid_shipstation_rate,
    shipStationExpenseCoverage: t.shipstation_expense_coverage, hpdOrdersActual: t.hpd_orders_actual,
    hpdOrdersPassThrough: t.hpd_orders_pass_through, insuranceDisclosed: t.insurance_disclosed,
    profitabilityStatus: t.profitability_status, labels: JSON.parse(t.labels || '{}'),
    hpdShippingBasis: JSON.parse(t.labels || '{}').hpdShippingBasis || null,
  };
}

function snapshotStatements(db, snapshotId, snap, meta) {
  const t = snap.totals;
  const breakdowns = Object.entries(snap.breakdowns).flatMap(([dimension, rows]) => rows.map(b => ({
    snapshot_id: snapshotId, dimension, key: b.key, units: b.units, known_cost_revenue: b.knownCostRevenue, known_cogs: b.knownCogs,
    known_cost_gp: b.knownCostGp, known_cost_margin: b.knownCostMargin, missing_cost_revenue: b.missingCostRevenue,
    missing_cost_units: b.missingCostUnits, missing_cost_lines: b.missingCostLines, coverage_status: b.coverageStatus,
    detail: dimension === 'sku' ? J({ sku: b.sku, vendor: b.vendor, product: b.product }) : null })));
  const orders = snap.orders.map(o => ({
    snapshot_id: snapshotId, order_name: o.orderName, business_date: o.date, channel: o.channel, order_cat: o.orderCat,
    operating_revenue: o.operatingRevenue, shopify_net_revenue: o.shopifyNetRevenue, route_collected: o.routeCollected,
    known_product_cogs: o.knownProductCogs, ship_collected: o.shipCollected, ship_paid: o.shipPaid, ship_paid_ss: o.shipPaidSS,
    ship_paid_hp: o.shipPaidHP, operating_gp: o.operatingGp, missing_cost_lines: o.missingCostLines,
    requires_ss_rate: o.requiresShipStationRate, has_valid_ss_rate: o.hasValidShipStationRate,
    shipping_expense_source: o.shippingExpenseSource, shipping_expense_status: o.shippingExpenseStatus,
    missing_reason: o.missingReason, profitability_status: o.profitabilityStatus, line_count: o.lineCount,
    hpd_shipping_basis: o.hpdShippingBasis || null }));
  const lines = snap.lines.map(l => ({
    snapshot_id: snapshotId, order_name: l.orderName, line_index: l.lineIndex, sku: l.sku, product: l.product,
    vendor_key: l.vendorKey, channel: l.channel, store: l.store, qty: l.qty, unit_price: l.unitPrice, unit_cost: l.unitCost,
    contract_revenue: l.contractRevenue, line_cogs: l.lineCogs, known_cost_gp: l.knownCostGp, cost_source: l.costSource,
    cost_match_type: l.costMatchType, missing_cost: l.missingCost ? 1 : 0, discount_allocated: l.discountAllocated,
    discount_source: l.discountSource, refund_allocated: l.refundAllocated, refund_source: l.refundSource,
    route_collected: l.routeCollected, route_remitted: l.routeRemitted, flags: J(l.flags) }));
  const issueKinds = [['missing_shipping', snap.issues.missingShipping], ['missing_cost', snap.issues.missingCost],
    ['unallocated_residual', snap.issues.unallocatedResiduals], ['unmatched_shipment', snap.issues.unmatchedShipments],
    ['excluded_by_engine', snap.issues.ordersExcludedByEngine]];
  let seq = 0;
  const issues = issueKinds.flatMap(([kind, list]) => (list || []).map(d => ({
    snapshot_id: snapshotId, seq: seq++, kind, order_name: d.orderName || null, detail: J(d) })));
  const recon = snap.reconciliation.map(c => ({ snapshot_id: snapshotId, check_name: c.check, expected: c.expected, actual: c.actual,
    delta: c.delta, passed: c.passed ? 1 : 0, blocking: c.blocking ? 1 : 0 }));

  return [
    db.prepare(`INSERT INTO snapshot (snapshot_id, week_start, revision, status, run_id, computed_at, engine_version, catalog_rev,
      policy, profitability_status, reason, catalog_info, comparison_snapshot_id, draft_comparison)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`)
      .bind(snapshotId, snap.weekStart, meta.revision, meta.status, meta.runId, nowIso(), ENGINE_VERSION, snap.catalogRev,
            J(snap.policy), t.profitabilityStatus, meta.reason, J(meta.catalogInfo), snap.narrative.comparison?.snapshotId || null,
            snap.draftComparison ? J(snap.draftComparison) : null),
    db.prepare(`INSERT INTO snapshot_totals VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
      ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30)`)
      .bind(snapshotId, t.operatingRevenue, t.shopifyNetRevenueInclPassThrough, t.operatingGpAfterShipping, t.operatingGpMargin,
            t.routeCollected, t.routeRemitted, t.routeNet, t.knownProductCogs, t.knownCostProductRevenue, t.knownCostProductGp,
            t.knownCostProductMargin, t.missingCostRevenue, t.missingCostUnits, t.missingCostLines, t.costCoverageByRevenue,
            t.costCoverageByUnits, t.shippingCollected, t.shippingExpense, t.shipStationExpense, t.hpdShippingExpense,
            t.ordersRequiringShipStationRate, t.ordersWithValidShipStationRate, t.shipStationExpenseCoverage,
            t.hpdOrdersActual, t.hpdOrdersPassThrough, t.insuranceDisclosed, t.profitabilityStatus, J(t.labels), J(snap.revenueBridge)),
    ...jsonInsert(db, 'snapshot_breakdown', ['snapshot_id', 'dimension', 'key', 'units', 'known_cost_revenue', 'known_cogs',
      'known_cost_gp', 'known_cost_margin', 'missing_cost_revenue', 'missing_cost_units', 'missing_cost_lines', 'coverage_status', 'detail'],
      breakdowns, { replace: false }),
    ...jsonInsert(db, 'snapshot_order', Object.keys(orders[0] || { snapshot_id: 1 }), orders, { replace: false }),
    ...jsonInsert(db, 'snapshot_line', Object.keys(lines[0] || { snapshot_id: 1 }), lines, { replace: false }),
    ...jsonInsert(db, 'snapshot_issue', ['snapshot_id', 'seq', 'kind', 'order_name', 'detail'], issues, { replace: false }),
    ...jsonInsert(db, 'snapshot_reconciliation', ['snapshot_id', 'check_name', 'expected', 'actual', 'delta', 'passed', 'blocking'], recon, { replace: false }),
    db.prepare('INSERT INTO snapshot_narrative (snapshot_id, narrative) VALUES (?1, ?2)').bind(snapshotId, J(snap.narrative)),
  ];
}


// ─── Catalog selection (Revision 6) ───────────────────────────────────────────
//
//   1. A week's FIRST run selects one catalog and records it on the run:
//      the catalog imported by this week's verified refresh when there is one,
//      otherwise the latest accepted catalog (which is then `stale`).
//   2. A retry or recompute of that run reuses the recorded catalog.
//   3. Any later run for a week that already has a snapshot (revision, source
//      update, backfill re-run) reuses the catalog of the week's published
//      snapshot, or of its latest snapshot when none is published.
//   4. Only an explicit, audited cost restatement applies another catalog.

export const REFRESH_TIMEOUT_MINUTES = 45;

const catalogCapturedAt = async (db, rev) =>
  rev ? (await db.prepare('SELECT captured_at FROM cost_catalog WHERE catalog_rev = ?1').bind(rev).first())?.captured_at || null : null;

export async function latestRefresh(db, weekStart) {
  const r = await db.prepare('SELECT * FROM catalog_refresh WHERE week_start = ?1 ORDER BY requested_at DESC, refresh_id DESC LIMIT 1').bind(weekStart).first();
  if (!r) return null;
  const expired = r.status === 'pending' && Date.now() - Date.parse(r.requested_at) > REFRESH_TIMEOUT_MINUTES * 60_000;
  return { ...r, effective_status: expired ? 'expired' : r.status, detail: JSON.parse(r.detail || '{}') };
}

async function weekAnchor(db, weekStart) {
  const pub = await db.prepare("SELECT snapshot_id, catalog_rev FROM snapshot WHERE week_start = ?1 AND status = 'published'").bind(weekStart).first();
  if (pub) return { rev: pub.catalog_rev, basis: 'published_snapshot', fromSnapshotId: pub.snapshot_id };
  const last = await db.prepare('SELECT snapshot_id, catalog_rev, catalog_info FROM snapshot WHERE week_start = ?1 ORDER BY revision DESC LIMIT 1').bind(weekStart).first();
  if (!last) return null;
  // An unpublished anchor passes on its own freshness: reusing a catalog that
  // was stale for this week keeps it stale (it needs acceptance or a restatement).
  const inherited = (() => { try { return JSON.parse(last.catalog_info || 'null')?.freshness?.status || null; } catch { return null; } })();
  return { rev: last.catalog_rev, basis: 'previous_snapshot', fromSnapshotId: last.snapshot_id, inheritedFreshness: inherited };
}

export { weekAnchor };

/** Rule 1 or 3. Rule 2 is the caller reusing run.catalog_info; rule 4 is restateCosts(). */
async function chooseCatalog(db, weekStart) {
  const anchor = await weekAnchor(db, weekStart);
  if (anchor) return { rev: anchor.rev, basis: anchor.basis, fromSnapshotId: anchor.fromSnapshotId, refreshId: null,
                      ...(anchor.inheritedFreshness !== undefined ? { inheritedFreshness: anchor.inheritedFreshness } : {}) };
  const refresh = await latestRefresh(db, weekStart);
  if (refresh?.effective_status === 'fulfilled' && refresh.catalog_rev) {
    return { rev: refresh.catalog_rev, basis: 'week_refresh', refreshId: refresh.refresh_id };
  }
  const latest = await latestAcceptedCatalogMeta(db);
  return { rev: latest?.catalog_rev || null, basis: 'latest_accepted', refreshId: refresh?.refresh_id || null,
           refreshStatus: refresh?.effective_status || 'none' };
}

/** Freshness of a recorded selection, for the gate. */
export async function catalogFreshness(db, runId, info) {
  let status, reason = null;
  if (!info?.rev) { status = 'stale'; reason = 'no_accepted_catalog'; }
  else if (info.basis === 'published_snapshot') status = 'intentionally_reused';
  else if (info.basis === 'previous_snapshot') {
    const ok = ['current', 'restated', 'reused_accepted', 'intentionally_reused'].includes(info.inheritedFreshness);
    status = ok ? 'intentionally_reused' : 'stale';
    if (!ok) reason = `inherited_${info.inheritedFreshness || 'unverified'}_catalog`;
  }
  else if (info.basis === 'cost_restatement') status = 'restated';
  else if (info.basis === 'week_refresh') status = 'current';
  else { status = 'stale'; reason = info.refreshStatus && info.refreshStatus !== 'none' ? `refresh_${info.refreshStatus}` : 'no_refresh_for_this_week'; }
  let acceptance = null;
  if (status === 'stale') {
    acceptance = await db.prepare('SELECT reason, actor_class AS actorClass, actor_label AS actorLabel, at FROM catalog_reuse_acceptance WHERE run_id = ?1 AND catalog_rev = ?2 ORDER BY id DESC LIMIT 1')
      .bind(runId, info.rev || '').first();
    if (acceptance) status = 'reused_accepted';
  }
  return { status, reason, acceptance: acceptance || null };
}

async function recordCatalogOnRun(db, runId, info, ownership = null) {
  const update = db.prepare('UPDATE reporting_run SET catalog_rev = ?2, catalog_info = ?3 WHERE run_id = ?1').bind(runId, info.rev, J(info));
  if (!ownership) { await update.run(); return; }
  try { await atomic(db, [ownGuard(db, ownership), update]); }
  catch (e) { if (isGuardAbort(e)) throw new ApiError(409, 'ownership_lost', 'Another request now owns this scheduled cycle; nothing was written'); throw e; }
}

/**
 * Test-only observation points for adversarial concurrency tests. Active only
 * when BOTH the TEST_HOOK service binding and TEST_HOOKS_ENABLED = "true" are
 * present; neither exists in worker/wrangler.toml (production or staging).
 */
async function testHook(env, point, data) {
  if (env.TEST_HOOKS_ENABLED !== 'true' || !env.TEST_HOOK) return;
  await env.TEST_HOOK.fetch(`https://test-hook/${point}`, { method: 'POST', body: JSON.stringify(data) });
}

export async function acceptCatalogReuse(db, run, info, acceptance, actor, ownership = null) {
  const reason = String(acceptance?.reason || '').trim();
  if (reason.length < 10) throw new ApiError(400, 'bad_payload', 'Accepting a stale catalog needs a reason of at least 10 characters');
  if (!info?.rev) throw new ApiError(409, 'no_catalog', 'There is no catalog to accept');
  const insert = db.prepare('INSERT INTO catalog_reuse_acceptance (run_id, week_start, catalog_rev, reason, actor_class, actor_label, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
    .bind(run.run_id, run.week_start, info.rev, reason, actor.cls, actor.label, nowIso());
  if (!ownership) { await insert.run(); return; }
  try { await atomic(db, [ownGuard(db, ownership), insert]); }
  catch (e) { if (isGuardAbort(e)) throw new ApiError(409, 'ownership_lost', 'Another request now owns this scheduled cycle; nothing was written'); throw e; }
}

// ─── Readiness and schedule (Revision 6; C5 inputs) ───────────────────────────

/**
 * C5 required inputs for a reporting week:
 *   shopify               sanitized Shopify orders export received (ingest run, mode 'week')
 *   shopify_updates       updated-order scan received (mode 'updated_since'; a rolling
 *                         export records it as a companion run)
 *   shipping_cost_report  a ShipStation Shipping Cost Report version received after the
 *                         week closed whose requested ship-date range covers the week
 *                         (pending_review or accepted; a rejected version does not count)
 *   catalog_refresh       the week's catalog refresh finished (either way)
 *   reporting_period      the week has closed in the store time zone
 * Informational only: `shipstation_mapping` (the dormant mapping export) never
 * satisfies shipping readiness, and `hpd` is optional.
 */
const INGEST_SOURCES = [
  { key: 'shopify', source: 'shopify', mode: 'week', required: true },
  { key: 'shopify_updates', source: 'shopify', mode: 'updated_since', required: true },
  { key: 'shipstation_mapping', source: 'shipstation', mode: null, required: false, satisfiesShippingReadiness: false },
  { key: 'hpd', source: 'hpd', mode: null, required: false },
];

/** The newest Shipping Cost Report version that can serve this week, if any. */
async function shippingCostReportFor(db, weekStart, win) {
  const weekEnd = addDays(weekStart, 6);
  const v = await db.prepare(`SELECT version_id, status, requested_from, requested_to, imported_at, comparison FROM shipping_cost_source_version
      WHERE requested_from <= ?1 AND requested_to >= ?2 AND imported_at >= ?3 AND status IN ('pending_review', 'accepted')
      ORDER BY imported_at DESC LIMIT 1`).bind(weekStart, weekEnd, win.endUtcExclusive).first();
  if (!v) return { required: true, status: 'missing', versionId: null };
  let trailingComplete = null;
  try { trailingComplete = !JSON.parse(v.comparison || '{}').possibleIncompleteTrailingDate; } catch { /* unknown */ }
  return { required: true, status: 'ok', versionId: v.version_id, versionStatus: v.status, requestedFrom: v.requested_from,
           requestedTo: v.requested_to, receivedAt: v.imported_at, trailingComplete };
}

/**
 * Has every required input for a week arrived AFTER the week closed, and has
 * the week's catalog refresh finished (either way)?
 */
export async function readiness(db, weekStart, settings, { now = Date.now() } = {}) {
  const win = weekWindowUtc(weekStart, settings.store_timezone);
  const sources = {};
  for (const s of INGEST_SOURCES) {
    const r = await db.prepare(`SELECT run_id, status, started_at, finished_at FROM ingest_run
        WHERE source = ?1 AND week_start = ?2 AND started_at >= ?3 AND (?4 IS NULL OR mode = ?4)
        ORDER BY started_at DESC LIMIT 1`).bind(s.source, weekStart, win.endUtcExclusive, s.mode).first();
    sources[s.key] = { required: s.required, status: r ? r.status : 'missing', runId: r?.run_id || null, finishedAt: r?.finished_at || null,
                       ...(s.satisfiesShippingReadiness === false ? { satisfiesShippingReadiness: false } : {}) };
  }
  sources.shipping_cost_report = await shippingCostReportFor(db, weekStart, win);
  const refresh = await latestRefresh(db, weekStart);
  const catalog = { status: refresh ? refresh.effective_status : 'missing', refreshId: refresh?.refresh_id || null,
                    catalogRev: refresh?.catalog_rev || null, requestedAt: refresh?.requested_at || null };
  const periodClosed = now >= Date.parse(win.endUtcExclusive);
  const missing = [];
  if (!periodClosed) missing.push('reporting_period:open');
  for (const [k, v] of Object.entries(sources)) if (v.required && v.status !== 'ok') missing.push(`${k}:${v.status}`);
  if (catalog.status === 'missing' || catalog.status === 'pending') missing.push(`catalog_refresh:${catalog.status}`);
  const schedule = { timeZone: settings.schedule_timezone, weekday: Number(settings.schedule_weekday), time: settings.schedule_time };
  const scheduledAt = scheduledRunFor(weekStart, schedule, settings.store_timezone).toISOString();
  return { weekStart, window: win, scheduledAt, due: now >= Date.parse(scheduledAt), periodClosed, sources, catalog,
           ready: missing.length === 0, missing };
}

// ─── Compute ──────────────────────────────────────────────────────────────────

/**
 * Compute one week. Creates a run unless `runId` is given (recompute).
 * `trigger: 'schedule'` runs only at/after the scheduled time and only when
 * every required source is ready, and is idempotent per week.
 */
export const STALE_COMPUTE_MINUTES = 15;

export async function computeWeek(env, { weekStart, runId = null, trigger = 'manual', actor, reason = null,
                                          acceptCatalogReuse: acceptance = null, presetCatalog = null, ownership = null }) {
  if (!actor?.cls) throw new Error('computeWeek needs an actor { cls, label }');
  if (trigger === 'schedule' && !ownership) throw new Error('scheduled computes go through computeScheduledWeek()');
  const db = env.DB;
  const settings = await getSettings(db);

  let run = runId ? await getRun(db, runId) : await createRun(db, weekStart, trigger, actor, reason);
  weekStart = run.week_start;
  // A compute killed mid-way (invocation limit, deploy) leaves the run in
  // `computing`. After STALE_COMPUTE_MINUTES it is failed so it can be recomputed.
  const own = ownership ? { ownership } : {};        // scheduled: every run write is claim-guarded
  if (run.state === 'computing' && isStale(env, run)) {
    run = await transition(db, run.run_id, 'failed', WORKER, { fields: { error: 'stale_compute' }, note: 'stale', ...own });
  }

  // Catalog: recorded once per run, before anything else, so retries reuse it.
  let info = run.catalog_info ? JSON.parse(run.catalog_info) : null;
  if (!info) {
    info = presetCatalog || await chooseCatalog(db, weekStart);
    info.capturedAt = await catalogCapturedAt(db, info.rev);
    await recordCatalogOnRun(db, run.run_id, info, ownership);
  }
  if (acceptance && String(acceptance.reason || '').trim().length < 10) {
    throw new ApiError(400, 'bad_payload', 'Accepting a stale catalog needs a reason of at least 10 characters');
  }

  run = await transition(db, run.run_id, 'computing', actor, { note: reason, ...own });
  try {
    if (acceptance) await acceptCatalogReuse(db, run, info, acceptance, actor, ownership);
    if (!info.rev) throw new ApiError(409, 'no_catalog', 'No accepted cost catalog; push one before computing');
    const catalog = await loadCatalog(db, info.rev);
    const catalogCompleteness = (await catalogMeta(db, info.rev))?.meta?.completeness || null;   // C6d: set on vendor-overlay catalogs
    const orders = await loadOrdersForWeek(db, weekStart);
    if (!orders.length) throw new ApiError(409, 'week_empty', `No orders ingested for the week of ${weekStart}`);
    const orderNumbers = [...new Set(orders.map(o => o.orderNumber))];
    const shipments = await loadShipmentsForOrders(db, orderNumbers);
    const hpd = await loadHpdForOrders(db, orderNumbers);
    const policy = { priority: ['carrierFee', 'legacyRate'], locked: settings.carrier_fee_priority_locked === true,
                     insuranceTreatment: settings.insurance_treatment || 'awaiting_confirmation' };
    const prev = await previousWeekSnapshots(db, weekStart);
    // C3: ShipStation expense is the Shipping Cost Report's Shipping Cost summed
    // per Shopify order, read through the active non-overlapping segments. The
    // mapping export is loaded for diagnostics only and is never an expense.
    const report = await reportForWeek(db, weekStart, orders);
    const snap = buildSnapshot({ weekStart, orders, shipments, hpdOrders: hpd, catalog, policy,
                                 previous: prev.published, previousDraft: prev.draft,
                                 shippingSource: SHIPPING_SOURCES.REPORT, shippingCostReport: report.byOrder,
                                 c3: { asOf: nowIso(), policySettings: settings, previousShippingExpense: report.previousShippingExpense,
                                       unmatchedReportOrders: report.unmatched, sourceVerified: settings.shipping_cost_report_source_verified === true, catalogCompleteness,
                                       provisionalEnabled: settings.provisional_publication_enabled === true,
                                       publicationAllowed: settings.publication_enabled === true && env.PUBLICATION_ALLOWED === 'true' } });
    const sources = { ...(await sourceStatus(db, weekStart, { orders, shipments, hpd })), shipstation: report.covers ? 'ok' : 'pending' };
    const freshness = await catalogFreshness(db, run.run_id, info);
    const catalogInfo = { ...info, freshness };
    const ordersInOtherTimezone = (await db.prepare(`SELECT COUNT(*) AS n FROM shopify_order WHERE week_start = ?1
      AND (normalized_timezone IS NULL OR normalized_timezone <> ?2)`).bind(weekStart, settings.store_timezone).first())?.n || 0;
    const gate = evaluateGate({ totals: snap.totals, reconciliation: snap.reconciliation, sources,
                                catalog: { accepted: true, rev: info.rev, freshness }, settings, ordersInOtherTimezone,
                                shippingC3: snap.shipping.c3 });
    const gateRecord = { ...gate, sources, storeTimezone: settings.store_timezone, storeTimezoneConfirmed: settings.store_timezone_confirmed === true,
      catalog: { expectedRefreshId: info.refreshId || null, selectedRev: info.rev,
      capturedAt: info.capturedAt, basis: info.basis, freshness } };
    const revision = ((await db.prepare('SELECT MAX(revision) AS m FROM snapshot WHERE week_start = ?1').bind(weekStart).first())?.m || 0) + 1;
    const snapshotId = newId('snp');
    const status = gate.passed ? 'draft' : 'blocked';
    const finalState = gate.passed ? 'validated' : 'blocked';
    const finalNote = gate.passed ? null : gate.failures.map(f => f.code).join(',');
    const snapStmts = snapshotStatements(db, snapshotId, snap, { revision, status, runId: run.run_id, reason: reason || run.reason, catalogInfo });
    if (ownership) {
      // Scheduled: snapshot + child rows, run fields, final state and BOTH
      // transition records commit in ONE transaction, and only while this
      // request still holds the claim and the run is still `computing`. There
      // is no moment where a snapshot exists without its run state, or where
      // a request that has lost the claim can change anything.
      await testHook(env, 'schedule:before_final_txn', { weekStart, runId: run.run_id, token: ownership.token });
      const at = nowIso();
      try {
        await atomic(db, [
          ownGuard(db, ownership),
          // The run must be exactly as this owner left it at its `computing` transition.
          guard(db, "EXISTS (SELECT 1 FROM reporting_run WHERE run_id = ?1 AND state = 'computing' AND updated_at = ?2)", run.run_id, run.updated_at),
          ...snapStmts,
          transitionInsert(db, run.run_id, 'computing', 'draft', at, WORKER, null),
          transitionInsert(db, run.run_id, 'draft', finalState, at, WORKER, finalNote),
          db.prepare(`UPDATE reporting_run SET state = ?2, snapshot_id = ?3, catalog_rev = ?4, gate = ?5, updated_at = ?6
                       WHERE run_id = ?1 AND state = 'computing' AND updated_at = ?7`).bind(run.run_id, finalState, snapshotId, info.rev, J(gateRecord), at, run.updated_at),
        ]);
      } catch (e) {
        if (isGuardAbort(e)) {
          if (!(await ownsCycle(db, ownership))) throw new ApiError(409, 'ownership_lost', 'Another request now owns this scheduled cycle; nothing was written');
          throw new ApiError(409, 'concurrent_transition', 'The run changed state concurrently; nothing was written');
        }
        throw e;
      }
      await testHook(env, 'schedule:after_final_txn', { weekStart, runId: run.run_id, token: ownership.token, snapshotId });
      run = await getRun(db, run.run_id);
    } else {
      // Manual / revision / backfill: unchanged, guarded two-step transitions.
      await atomic(db, snapStmts);
      run = await transition(db, run.run_id, 'draft', WORKER, { fields: { snapshot_id: snapshotId, catalog_rev: info.rev, gate: J(gateRecord) } });
      run = await transition(db, run.run_id, finalState, WORKER, { note: finalNote });
    }
    return { run, snapshotId, revision, status, gate: gateRecord,
             profitabilityStatus: snap.totals.profitabilityStatus, headline: snap.narrative.headline };
  } catch (e) {
    const code = e instanceof ApiError ? e.code : 'compute_failed';
    if (code === 'ownership_lost' || code === 'concurrent_transition') throw e;   // not ours to mark failed
    // Scheduled: the failed transition is claim-guarded too (a lost owner cannot flip the run).
    try { await transition(db, run.run_id, 'failed', WORKER, { fields: { error: code }, ...own }); }
    catch (t) { if (t?.code === 'ownership_lost') throw t; /* otherwise already terminal */ }
    if (e instanceof ApiError) throw e;
    throw new ApiError(500, 'compute_failed', 'Snapshot computation failed; see the run record');
  }
}

async function runSummary(db, runId) {
  const run = await getRun(db, runId);
  const snap = run.snapshot_id ? await db.prepare('SELECT snapshot_id, revision, status, profitability_status FROM snapshot WHERE snapshot_id = ?1').bind(run.snapshot_id).first() : null;
  return { run, snapshotId: snap?.snapshot_id || null, revision: snap?.revision || null, status: snap?.status || null,
           gate: run.gate ? JSON.parse(run.gate) : null, profitabilityStatus: snap?.profitability_status || null, headline: null };
}

// ─── Publish (atomic, idempotent) ─────────────────────────────────────────────

/** Statements that abort the batch unless `condition` (SQL) holds. */
const guard = (db, condition, ...params) =>
  db.prepare(`INSERT INTO write_guard (ok) SELECT NULL WHERE NOT (${condition})`).bind(...params);

/** Aborts the batch unless this request still holds the scheduled cycle's claim. */
const ownGuard = (db, ownership) =>
  guard(db, 'EXISTS (SELECT 1 FROM schedule_cycle WHERE week_start = ?1 AND claim_token = ?2)', ownership.weekStart, ownership.token);

const transitionInsert = (db, runId, from, to, at, actor, note) =>
  db.prepare(`INSERT INTO run_transition (run_id, seq, from_state, to_state, at, actor_class, actor_label, note)
    SELECT ?1, (SELECT COALESCE(MAX(seq), -1) + 1 FROM run_transition WHERE run_id = ?1), ?2, ?3, ?4, ?5, ?6, ?7`)
    .bind(runId, from, to, at, actor.cls, actor.label, note);

const isGuardAbort = e => /NOT NULL constraint failed: write_guard/i.test(String(e?.message || e));

/**
 * Publish a validated draft. Refused unless the Carrier Fee priority is locked,
 * the gate passed, and BOTH go-live locks are set. The snapshot, any superseded
 * snapshot and the run move together in ONE transaction. A retry after any
 * failure is safe: an already-published target is reported, and a published
 * snapshot whose run was left `validated` (older builds) is repaired.
 */
export async function publishSnapshot(env, snapshotId, actor) {
  if (!actor?.cls) throw new Error('publishSnapshot needs an actor { cls, label }');
  const db = env.DB;
  const snap = await db.prepare('SELECT * FROM snapshot WHERE snapshot_id = ?1').bind(snapshotId).first();
  if (!snap) throw new ApiError(404, 'snapshot_unknown', `No snapshot ${snapshotId}`);
  const run = await getRun(db, snap.run_id);
  const result = extra => ({ snapshotId, weekStart: snap.week_start, revision: snap.revision, ...extra });

  if (snap.status === 'published') {
    if (run.state === 'published') return result({ publishedAt: snap.published_at, alreadyPublished: true });
    if (run.state === 'validated' && run.snapshot_id === snapshotId) return result({ publishedAt: snap.published_at, ...(await repairRun(db, run, snapshotId, actor)) });
    throw new ApiError(409, 'inconsistent_state', `Snapshot is published but its run is ${run.state}`);
  }

  const gate = JSON.parse(run.gate || '{"passed":false}');
  const settings = await getSettings(db);
  const verdict = canPublish(gate, settings, env.PUBLICATION_ALLOWED);
  if (!verdict.allowed) throw new ApiError(409, 'not_publishable', `Publication refused: ${verdict.reason}`, { reason: verdict.reason });
  if (snap.status !== 'draft' || run.state !== 'validated') throw new ApiError(409, 'not_publishable', 'Only a validated draft can be published');
  // The run's gate belongs to its latest snapshot only. An older draft of the
  // same run (before a recompute) was never checked against this gate.
  if (run.snapshot_id !== snapshotId) throw new ApiError(409, 'not_publishable', 'This draft was replaced by a later revision of the same run');
  // Only the week's newest revision may be published: publishing an older one
  // would silently undo a later revision or cost restatement.
  const newer = await db.prepare('SELECT revision FROM snapshot WHERE week_start = ?1 AND revision > ?2 LIMIT 1').bind(snap.week_start, snap.revision).first();
  if (newer) throw new ApiError(409, 'not_latest_revision', `Revision ${newer.revision} of this week is newer; publish that one or revise again`, { reason: 'not_latest_revision' });
  // The stored narrative compares with the prior week's published snapshot as
  // it was at compute time. If that has changed, recompute first.
  const prevWeek = addDays(snap.week_start, -7);
  const prevPub = (await db.prepare("SELECT snapshot_id FROM snapshot WHERE week_start = ?1 AND status = 'published'").bind(prevWeek).first())?.snapshot_id || null;
  if (prevPub !== (snap.comparison_snapshot_id || null)) {
    throw new ApiError(409, 'comparison_stale', 'The prior week was published or revised after this draft was computed; recompute before publishing', { reason: 'comparison_stale' });
  }

  const at = nowIso(), token = newId('pub');
  try {
    await atomic(db, [
      guard(db, `EXISTS (SELECT 1 FROM reporting_run WHERE run_id = ?1 AND state = 'validated' AND snapshot_id = ?2)
             AND EXISTS (SELECT 1 FROM snapshot WHERE snapshot_id = ?2 AND status = 'draft')
             AND (SELECT snapshot_id FROM snapshot WHERE week_start = ?3 AND status = 'published') IS ?4
             AND NOT EXISTS (SELECT 1 FROM snapshot WHERE week_start = ?5 AND revision > ?6)`,
            run.run_id, snapshotId, prevWeek, prevPub, snap.week_start, snap.revision),
      db.prepare(`UPDATE snapshot SET status = 'superseded', superseded_by = ?2
                   WHERE week_start = ?1 AND status = 'published' AND snapshot_id <> ?2`).bind(snap.week_start, snapshotId),
      db.prepare("UPDATE snapshot SET status = 'published', published_at = ?2, publish_token = ?3 WHERE snapshot_id = ?1 AND status = 'draft'")
        .bind(snapshotId, at, token),
      db.prepare("UPDATE reporting_run SET state = 'published', updated_at = ?2 WHERE run_id = ?1 AND state = 'validated'").bind(run.run_id, at),
      transitionInsert(db, run.run_id, 'validated', 'published', at, actor, null),
    ]);
  } catch (e) {
    if (!isGuardAbort(e)) throw e;
    // Preconditions changed between the checks above and the transaction
    // (a concurrent publish or recompute). Re-read and answer idempotently.
    const now = await db.prepare('SELECT status, published_at FROM snapshot WHERE snapshot_id = ?1').bind(snapshotId).first();
    const r2 = await getRun(db, run.run_id);
    if (now?.status === 'published' && r2.state === 'published') return result({ publishedAt: now.published_at, alreadyPublished: true });
    throw new ApiError(409, 'not_publishable', 'The draft changed while publishing; re-read it and retry');
  }
  return result({ publishedAt: at });
}

async function repairRun(db, run, snapshotId, actor) {
  const at = nowIso();
  try {
    await atomic(db, [
      guard(db, `EXISTS (SELECT 1 FROM reporting_run WHERE run_id = ?1 AND state = 'validated' AND snapshot_id = ?2)
             AND EXISTS (SELECT 1 FROM snapshot WHERE snapshot_id = ?2 AND status = 'published')`, run.run_id, snapshotId),
      db.prepare("UPDATE reporting_run SET state = 'published', updated_at = ?2 WHERE run_id = ?1 AND state = 'validated'").bind(run.run_id, at),
      transitionInsert(db, run.run_id, 'validated', 'published', at, actor, 'repaired: snapshot was already published'),
    ]);
  } catch (e) {
    if (!isGuardAbort(e)) throw e;
    const r2 = await getRun(db, run.run_id);
    if (r2.state === 'published') return { alreadyPublished: true };
    throw new ApiError(409, 'inconsistent_state', `Could not repair run ${run.run_id} (state ${r2.state})`);
  }
  return { repaired: true };
}

// ─── Scheduled cycle: atomic, database-enforced ownership (Revision 7) ────────

const SETTLED = new Set(['validated', 'blocked', 'published']);
/**
 * Stale = untouched for STALE_COMPUTE_MINUTES. Tests shorten it with
 * TEST_STALE_MS, honoured only together with TEST_HOOKS_ENABLED = "true"
 * (neither is set in wrangler.toml), so a stall is simulated by time passing
 * rather than by rewriting the run.
 */
const staleMs = env => (env?.TEST_HOOKS_ENABLED === 'true' && Number(env?.TEST_STALE_MS) > 0) ? Number(env.TEST_STALE_MS) : STALE_COMPUTE_MINUTES * 60_000;
const isStale = (env, run) => Date.now() - Date.parse(run.updated_at) > staleMs(env);

/**
 * The single entry point for `trigger: 'schedule'`.
 *
 *   1. Refused before the week's Monday 15:30 slot, and (for a new or resumed
 *      cycle) until every required source is ready.
 *   2. CLAIM: one D1 batch inserts schedule_cycle(week_start PK) with
 *      ON CONFLICT DO NOTHING and creates the reporting run only if that
 *      insert won (INSERT … SELECT … WHERE EXISTS claim_token). Two
 *      simultaneous requests cannot both create a run: the loser inserts nothing.
 *   3. EXISTING: a settled run (draft/validated/blocked/published) is returned
 *      with existing: true; a live run in progress likewise, with inProgress.
 *   4. RESUME: a failed run, or one stuck in created/computing/draft longer than
 *      STALE_COMPUTE_MINUTES, is resumed IN PLACE after a compare-and-swap on
 *      claim_token. The same run is recomputed; no second scheduled run exists.
 *   5. The snapshot write re-checks the claim token, so a request that lost
 *      ownership mid-way cannot write a snapshot.
 */
export async function computeScheduledWeek(env, { weekStart, actor }) {
  // Fifth control: the scheduled path is off unless the Worker environment
  // explicitly allows automation. worker/wrangler.toml sets it "false".
  if (env.AUTOMATION_ENABLED !== 'true') throw new ApiError(409, 'automation_disabled', 'Scheduled computation is disabled in this environment (AUTOMATION_ENABLED is not "true")');
  const db = env.DB;
  const settings = await getSettings(db);
  const ready = await readiness(db, weekStart, settings);
  if (!ready.due) throw new ApiError(409, 'too_early', `The scheduled run for ${weekStart} is due at ${ready.scheduledAt}`, { scheduledAt: ready.scheduledAt });
  const notReady = () => new ApiError(409, 'sources_not_ready', `Not ready: ${ready.missing.join(', ')}`,
    { missing: ready.missing, sources: ready.sources, catalog: ready.catalog });

  let cycle = await db.prepare('SELECT * FROM schedule_cycle WHERE week_start = ?1').bind(weekStart).first();
  if (!cycle) {
    if (!ready.ready) throw notReady();
    const runId = newId('run'), token = newId('clm'), at = nowIso();
    const owned = 'EXISTS (SELECT 1 FROM schedule_cycle WHERE week_start = ?1 AND claim_token = ?2)';
    const [claim] = await atomic(db, [
      db.prepare(`INSERT INTO schedule_cycle (week_start, run_id, claim_token, claimed_at, attempts, created_at)
        VALUES (?1, ?2, ?3, ?4, 1, ?4) ON CONFLICT(week_start) DO NOTHING`).bind(weekStart, runId, token, at),
      db.prepare(`INSERT INTO reporting_run (run_id, week_start, state, trigger, created_at, updated_at, reason)
        SELECT ?3, ?1, 'created', 'schedule', ?4, ?4, 'scheduled cycle' WHERE ${owned}`).bind(weekStart, token, runId, at),
      db.prepare(`INSERT INTO run_transition (run_id, seq, from_state, to_state, at, actor_class, actor_label, note)
        SELECT ?3, 0, NULL, 'created', ?4, ?5, ?6, 'schedule' WHERE ${owned}`).bind(weekStart, token, runId, at, actor.cls, actor.label),
    ]);
    if (claim?.meta?.changes === 1) return runOwnedCycle(env, { weekStart, runId, token, actor, attempt: 1 });
    cycle = await db.prepare('SELECT * FROM schedule_cycle WHERE week_start = ?1').bind(weekStart).first();   // lost the race
  }

  const run = await getRun(db, cycle.run_id);
  const cycleInfo = { weekStart, runId: cycle.run_id, attempts: cycle.attempts, claimedAt: cycle.claimed_at };
  if (SETTLED.has(run.state) || run.state === 'cancelled') return { ...(await runSummary(db, run.run_id)), existing: true, cycle: cycleInfo };
  // Resumable: failed; or left mid-way (created / computing / draft) by a request
  // that is gone — stale, or (for created) one that already recorded an error.
  const resumable = run.state === 'failed'
    || (['created', 'computing', 'draft'].includes(run.state) && isStale(env, run))
    || (run.state === 'created' && !!cycle.last_error);
  if (!resumable) return { ...(await runSummary(db, run.run_id)), existing: true, inProgress: true, cycle: cycleInfo };
  if (!ready.ready) throw notReady();

  // Takeover = compare-and-swap on the claim token AND on the run being exactly
  // as observed (same state, same updated_at). If the current owner commits,
  // or another request takes over first, this changes nothing.
  const token = newId('clm'), at = nowIso();
  let cas;
  try {
    [, cas] = await atomic(db, [
      guard(db, 'EXISTS (SELECT 1 FROM reporting_run WHERE run_id = ?1 AND state = ?2 AND updated_at = ?3)', run.run_id, run.state, run.updated_at),
      db.prepare(`UPDATE schedule_cycle SET claim_token = ?3, claimed_at = ?4, attempts = attempts + 1
        WHERE week_start = ?1 AND claim_token = ?2`).bind(weekStart, cycle.claim_token, token, at),
    ]);
  } catch (e) { if (!isGuardAbort(e)) throw e; cas = null; }
  if (cas?.meta?.changes !== 1) {   // the owner finished, or another request took over first
    return { ...(await runSummary(db, run.run_id)), existing: true, inProgress: !SETTLED.has((await getRun(db, run.run_id)).state), cycle: cycleInfo };
  }
  return runOwnedCycle(env, { weekStart, runId: cycle.run_id, token, actor, attempt: cycle.attempts + 1, resumed: true });
}

async function runOwnedCycle(env, { weekStart, runId, token, actor, attempt, resumed = false, reason = null, acceptance = null }) {
  try {
    const r = await computeWeek(env, { runId, trigger: 'schedule', actor, ownership: { weekStart, token }, acceptCatalogReuse: acceptance,
      reason: reason || (resumed ? `resumed scheduled cycle (attempt ${attempt})` : null) });
    await env.DB.prepare('UPDATE schedule_cycle SET last_error = NULL WHERE week_start = ?1 AND claim_token = ?2').bind(weekStart, token).run();
    return { ...r, existing: false, ...(resumed ? { resumed: true } : {}), cycle: { weekStart, runId, attempts: attempt } };
  } catch (e) {
    await env.DB.prepare('UPDATE schedule_cycle SET last_error = ?3 WHERE week_start = ?1 AND claim_token = ?2')
      .bind(weekStart, token, e.code || 'compute_failed').run().catch(() => {});
    throw e;
  }
}

/**
 * An administrator's recompute of a SCHEDULED run (e.g. to accept catalog
 * reuse) goes through the cycle's ownership too: it takes the claim by the
 * same compare-and-swap as a takeover, then computes as the owner. A run that
 * another request is actively computing (not yet stale) is refused.
 */
export async function recomputeScheduledRun(env, { runId, actor, reason = null, acceptance = null }) {
  const db = env.DB;
  const cycle = await db.prepare('SELECT * FROM schedule_cycle WHERE run_id = ?1').bind(runId).first();
  if (!cycle) throw new ApiError(409, 'no_cycle', `Scheduled run ${runId} has no schedule cycle`);
  const run = await getRun(db, runId);
  if (['created', 'computing', 'draft'].includes(run.state) && !isStale(env, run)) {
    throw new ApiError(409, 'scheduled_run_in_progress', 'This scheduled run is being computed; retry after it settles (or once it is stale)');
  }
  if (acceptance && String(acceptance.reason || '').trim().length < 10) {
    throw new ApiError(400, 'bad_payload', 'Accepting a stale catalog needs a reason of at least 10 characters');
  }
  const token = newId('clm'), at = nowIso();
  let cas;
  try {
    [, cas] = await atomic(db, [
      guard(db, 'EXISTS (SELECT 1 FROM reporting_run WHERE run_id = ?1 AND state = ?2 AND updated_at = ?3)', run.run_id, run.state, run.updated_at),
      db.prepare(`UPDATE schedule_cycle SET claim_token = ?3, claimed_at = ?4, attempts = attempts + 1
        WHERE week_start = ?1 AND claim_token = ?2`).bind(cycle.week_start, cycle.claim_token, token, at),
    ]);
  } catch (e) { if (!isGuardAbort(e)) throw e; cas = null; }
  if (cas?.meta?.changes !== 1) throw new ApiError(409, 'concurrent_transition', 'The scheduled run changed while claiming it; re-read and retry');
  return runOwnedCycle(env, { weekStart: cycle.week_start, runId, token, actor, attempt: cycle.attempts + 1, resumed: true,
                              reason: reason || 'admin recompute of a scheduled run', acceptance });
}
