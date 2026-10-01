/**
 * resultParts.js — one weekly snapshot as stored rows and as result parts
 * =======================================================================
 * The ONE mapping from a buildSnapshot() result to what the dashboard reads.
 *
 *   rows   (Worker-computed weeks)  snapshot_order / _line / _breakdown / _issue /
 *                                   _reconciliation / _totals rows (compute.js)
 *   parts  (collector-computed weeks, Free-tier path) the SAME row objects,
 *                                   grouped into a few gzip JSON parts
 *
 * Every row object is exactly what D1 hands back for that table: SQLite column
 * affinity is applied here (booleans → 1/0, numbers in TEXT columns → text,
 * numeric text in REAL/INTEGER columns → numbers, undefined → null), so the
 * read routes return identical JSON for both storage modes. Pure; no I/O.
 */
import { stableStringify } from './normalized.js';

const J = v => JSON.stringify(v ?? null);
const NUMERIC_TEXT = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/;
function affinity(type, v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') v = v ? 1 : 0;
  if (type === 'TEXT') return typeof v === 'number' ? String(v) : v;
  if (typeof v === 'string' && NUMERIC_TEXT.test(v)) return Number(v);
  return v;
}
const typed = (types, o) => { const r = {}; for (const [k, t] of types) r[k] = affinity(t, o[k]); return r; };
const cols = spec => spec.trim().split(/\s+/).map(s => s.split(':'));

export const ORDER_COLUMNS = cols(`order_name:TEXT business_date:TEXT channel:TEXT order_cat:TEXT operating_revenue:REAL
  shopify_net_revenue:REAL route_collected:REAL known_product_cogs:REAL ship_collected:REAL ship_paid:REAL ship_paid_ss:REAL
  ship_paid_hp:REAL operating_gp:REAL missing_cost_lines:INTEGER requires_ss_rate:INTEGER has_valid_ss_rate:INTEGER
  shipping_expense_source:TEXT shipping_expense_status:TEXT missing_reason:TEXT profitability_status:TEXT line_count:INTEGER
  hpd_shipping_basis:TEXT`);
export const LINE_COLUMNS = cols(`order_name:TEXT line_index:INTEGER sku:TEXT product:TEXT vendor_key:TEXT channel:TEXT store:TEXT
  qty:INTEGER unit_price:REAL unit_cost:REAL contract_revenue:REAL line_cogs:REAL known_cost_gp:REAL cost_source:TEXT
  cost_match_type:TEXT missing_cost:INTEGER discount_allocated:REAL discount_source:TEXT refund_allocated:REAL refund_source:TEXT
  route_collected:REAL route_remitted:REAL flags:TEXT`);
export const BREAKDOWN_COLUMNS = cols(`dimension:TEXT key:TEXT units:INTEGER known_cost_revenue:REAL known_cogs:REAL known_cost_gp:REAL
  known_cost_margin:REAL missing_cost_revenue:REAL missing_cost_units:INTEGER missing_cost_lines:INTEGER coverage_status:TEXT detail:TEXT`);
export const ISSUE_COLUMNS = cols('seq:INTEGER kind:TEXT order_name:TEXT detail:TEXT');
export const RECON_COLUMNS = cols('check_name:TEXT expected:REAL actual:REAL delta:REAL passed:INTEGER blocking:INTEGER');
export const TOTALS_COLUMNS = cols(`operating_revenue:REAL shopify_net_revenue_incl_pass_through:REAL operating_gp_after_shipping:REAL
  operating_gp_margin:REAL route_collected:REAL route_remitted:REAL route_net:REAL known_product_cogs:REAL known_cost_product_revenue:REAL
  known_cost_product_gp:REAL known_cost_product_margin:REAL missing_cost_revenue:REAL missing_cost_units:INTEGER missing_cost_lines:INTEGER
  cost_coverage_by_revenue:REAL cost_coverage_by_units:REAL shipping_collected:REAL shipping_expense:REAL shipstation_expense:REAL
  hpd_shipping_expense:REAL orders_requiring_shipstation_rate:INTEGER orders_with_valid_shipstation_rate:INTEGER
  shipstation_expense_coverage:REAL hpd_orders_actual:INTEGER hpd_orders_pass_through:INTEGER insurance_disclosed:REAL
  profitability_status:TEXT labels:TEXT revenue_bridge:TEXT`);

export const orderRow = o => typed(ORDER_COLUMNS, {
  order_name: o.orderName, business_date: o.date, channel: o.channel, order_cat: o.orderCat,
  operating_revenue: o.operatingRevenue, shopify_net_revenue: o.shopifyNetRevenue, route_collected: o.routeCollected,
  known_product_cogs: o.knownProductCogs, ship_collected: o.shipCollected, ship_paid: o.shipPaid, ship_paid_ss: o.shipPaidSS,
  ship_paid_hp: o.shipPaidHP, operating_gp: o.operatingGp, missing_cost_lines: o.missingCostLines,
  requires_ss_rate: o.requiresShipStationRate, has_valid_ss_rate: o.hasValidShipStationRate,
  shipping_expense_source: o.shippingExpenseSource, shipping_expense_status: o.shippingExpenseStatus,
  missing_reason: o.missingReason, profitability_status: o.profitabilityStatus, line_count: o.lineCount,
  hpd_shipping_basis: o.hpdShippingBasis || null });

export const lineRow = l => typed(LINE_COLUMNS, {
  order_name: l.orderName, line_index: l.lineIndex, sku: l.sku, product: l.product,
  vendor_key: l.vendorKey, channel: l.channel, store: l.store, qty: l.qty, unit_price: l.unitPrice, unit_cost: l.unitCost,
  contract_revenue: l.contractRevenue, line_cogs: l.lineCogs, known_cost_gp: l.knownCostGp, cost_source: l.costSource,
  cost_match_type: l.costMatchType, missing_cost: l.missingCost ? 1 : 0, discount_allocated: l.discountAllocated,
  discount_source: l.discountSource, refund_allocated: l.refundAllocated, refund_source: l.refundSource,
  route_collected: l.routeCollected, route_remitted: l.routeRemitted, flags: J(l.flags) });

export const breakdownRows = snap => Object.entries(snap.breakdowns).flatMap(([dimension, rows]) => rows.map(b => typed(BREAKDOWN_COLUMNS, {
  dimension, key: b.key, units: b.units, known_cost_revenue: b.knownCostRevenue, known_cogs: b.knownCogs,
  known_cost_gp: b.knownCostGp, known_cost_margin: b.knownCostMargin, missing_cost_revenue: b.missingCostRevenue,
  missing_cost_units: b.missingCostUnits, missing_cost_lines: b.missingCostLines, coverage_status: b.coverageStatus,
  detail: dimension === 'sku' ? J({ sku: b.sku, vendor: b.vendor, product: b.product }) : null })));

export const ISSUE_KINDS = [['missing_shipping', 'missingShipping'], ['missing_cost', 'missingCost'], ['unallocated_residual', 'unallocatedResiduals'],
  ['unmatched_shipment', 'unmatchedShipments'], ['excluded_by_engine', 'ordersExcludedByEngine']];
export function issueRows(snap) {
  let seq = 0;
  return ISSUE_KINDS.flatMap(([kind, key]) => (snap.issues[key] || []).map(d => typed(ISSUE_COLUMNS, {
    seq: seq++, kind, order_name: d.orderName || null, detail: J(d) })));
}

export const reconRows = snap => snap.reconciliation.map(c => typed(RECON_COLUMNS, {
  check_name: c.check, expected: c.expected, actual: c.actual, delta: c.delta, passed: c.passed ? 1 : 0, blocking: c.blocking ? 1 : 0 }));

export function totalsRow(snap) {
  const t = snap.totals;
  return typed(TOTALS_COLUMNS, {
    operating_revenue: t.operatingRevenue, shopify_net_revenue_incl_pass_through: t.shopifyNetRevenueInclPassThrough,
    operating_gp_after_shipping: t.operatingGpAfterShipping, operating_gp_margin: t.operatingGpMargin,
    route_collected: t.routeCollected, route_remitted: t.routeRemitted, route_net: t.routeNet, known_product_cogs: t.knownProductCogs,
    known_cost_product_revenue: t.knownCostProductRevenue, known_cost_product_gp: t.knownCostProductGp,
    known_cost_product_margin: t.knownCostProductMargin, missing_cost_revenue: t.missingCostRevenue, missing_cost_units: t.missingCostUnits,
    missing_cost_lines: t.missingCostLines, cost_coverage_by_revenue: t.costCoverageByRevenue, cost_coverage_by_units: t.costCoverageByUnits,
    shipping_collected: t.shippingCollected, shipping_expense: t.shippingExpense, shipstation_expense: t.shipStationExpense,
    hpd_shipping_expense: t.hpdShippingExpense, orders_requiring_shipstation_rate: t.ordersRequiringShipStationRate,
    orders_with_valid_shipstation_rate: t.ordersWithValidShipStationRate, shipstation_expense_coverage: t.shipStationExpenseCoverage,
    hpd_orders_actual: t.hpdOrdersActual, hpd_orders_pass_through: t.hpdOrdersPassThrough, insurance_disclosed: t.insuranceDisclosed,
    profitability_status: t.profitabilityStatus, labels: J(t.labels), revenue_bridge: J(snap.revenueBridge) });
}

/** snapshot_totals row → the totals object the API and the next week's comparison read. */
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

/** The snapshot row's own content fields (the Worker adds ids, revision, status and timestamps). */
export const headOf = (snap, engineVersion) => ({
  engine_version: engineVersion, catalog_rev: snap.catalogRev ?? null, policy: J(snap.policy),
  profitability_status: snap.totals.profitabilityStatus,
  comparison_snapshot_id: snap.narrative?.comparison?.snapshotId || null,
  draft_comparison: snap.draftComparison ? J(snap.draftComparison) : null });

/**
 * Compact line set for the browser's scenario calculator (the scenario-input
 * route): product lines and Route only; order-level shipping on each order's
 * first line. `orders` / `lines` are row objects, lines in order_name, line_index order.
 */
export function scenarioLines(orders, lines) {
  const byName = new Map(orders.map(o => [o.order_name, o]));
  const seen = new Set(), out = [];
  for (const l of lines) {
    let flags = {}; try { flags = JSON.parse(l.flags || '{}') || {}; } catch { flags = {}; }
    if (!flags.isProductLine && !flags.isRoute) continue;
    const o = byName.get(l.order_name) || {};
    const first = !seen.has(l.order_name); seen.add(l.order_name);
    const revenue = flags.isRoute ? l.route_collected : l.contract_revenue;
    out.push({ orderNum: l.order_name, date: o.business_date, sku: l.sku, product: l.product, vendor: l.vendor_key,
      vendorKey: l.vendor_key, qty: l.qty, unitPrice: l.unit_price, baseMerchRevenue: Math.round((l.unit_price || 0) * (l.qty || 0) * 100) / 100,
      lineRevenue: revenue, lineCogs: l.line_cogs, missingCost: !!l.missing_cost, costSource: l.cost_source,
      isRoute: !!flags.isRoute, isGiftCard: !!flags.isGiftCard, isInfluencerSample: !!flags.isInfluencerSample,
      shipCollected: first ? o.ship_collected : null, shipPaid: first ? o.ship_paid : null });
  }
  return out;
}

export const ORDERS_PER_LINE_PART = 40;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * All parts of a snapshot as canonical strings (stableStringify), plus the
 * per-order strings the verifier compares one by one.
 *   summary   { orders: [orderRow…] in engine order, part: { orderName: k } }
 *   lines:k   { lines: [lineRow…] } for 40 orders (by order name), line_index order
 *   sections  { breakdowns, reconciliation, issues, shippingC3 }
 *   scenario  { lines: scenarioLines(…) }
 */
export function resultParts(snap, engineVersion) {
  const orders = snap.orders.map(orderRow);
  const lines = snap.lines.map(lineRow).sort((a, b) => cmp(a.order_name, b.order_name) || a.line_index - b.line_index);
  const names = [...new Set(orders.map(o => o.order_name))].sort(cmp);
  const partOf = {}; names.forEach((n, i) => { partOf[n] = Math.floor(i / ORDERS_PER_LINE_PART); });
  const byOrder = new Map(names.map(n => [n, []]));
  for (const l of lines) (byOrder.get(l.order_name) || byOrder.set(l.order_name, []).get(l.order_name)).push(l);
  const parts = { summary: stableStringify({ orders, part: partOf }) };
  const nParts = Math.ceil(names.length / ORDERS_PER_LINE_PART);
  for (let k = 0; k < nParts; k++) parts[`lines:${k}`] = stableStringify({ lines: names.slice(k * ORDERS_PER_LINE_PART, (k + 1) * ORDERS_PER_LINE_PART).flatMap(n => byOrder.get(n) || []) });
  // Lines of an order the summary does not list (should not happen) still land in a part.
  const stray = [...byOrder.keys()].filter(n => !(n in partOf));
  if (stray.length) parts[`lines:${nParts}`] = stableStringify({ lines: stray.sort(cmp).flatMap(n => byOrder.get(n)) });
  parts.sections = stableStringify({ breakdowns: breakdownRows(snap), reconciliation: reconRows(snap), issues: issueRows(snap),
    shippingC3: snap.shipping?.c3 ?? null });
  parts.scenario = stableStringify({ lines: scenarioLines(orders, lines) });
  const orderStrings = orders.map(o => [o.order_name, stableStringify({ order: o, lines: byOrder.get(o.order_name) || [] })]);
  return {
    parts, orderStrings,
    head: headOf(snap, engineVersion),
    totals: stableStringify(totalsRow(snap)),
    narrative: stableStringify(snap.narrative ?? null),
    gateInputs: { totals: snap.totals, reconciliation: snap.reconciliation, shippingC3: snap.shipping?.c3 ?? null },
  };
}
