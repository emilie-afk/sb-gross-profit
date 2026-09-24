/**
 * snapshot.js — build one weekly snapshot from normalized sources
 * ===============================================================
 * Pure and deterministic: same inputs, same snapshot. The Worker calls this
 * after ingestion; tests call it with synthetic fixtures; a local tool can call
 * it with historical exports to validate against the manual calculator.
 *
 *   normalized orders ─► legacy rows ─► calculate() ─► summarize()
 *                                            │
 *                         allocation contract ─► metrics ─► reconciliation ─► narrative
 *   normalized shipments ─► expense selection ─┘      ▲
 *   normalized HPD ─────────► HPD map ────────────────┘
 */
import { calculate, summarize } from './calculator.js';
import { toLegacyShopifyRows, attachLineKeys, toLegacyShipStationCosts, toLegacyHpdMap } from './adapters/legacy.js';
import { DEFAULT_EXPENSE_POLICY } from './adapters/shipstation.js';
import { applyAllocationContract } from './allocation.js';
import { diagnoseShipping } from './shippingDiagnostic.js';
import { computeMetrics, orderResults } from './metrics.js';
import { buildNarrative, draftComparison } from './narrative.js';
import { engineArgsFromCatalog } from './catalog.js';
import { r2, addDays } from './normalized.js';

export const ENGINE_VERSION = '2026.09.24-phase1';

function check(name, expected, actual, { blocking = true, tolerance = 0.005 } = {}) {
  const delta = r2(actual - expected);
  return { check: name, expected: r2(expected), actual: r2(actual), delta, passed: Math.abs(delta) <= tolerance, blocking };
}

/**
 * @param {object} p
 * @param {string} p.weekStart          Monday, YYYY-MM-DD (store time zone)
 * @param {object[]} p.orders           NormalizedOrder[] for the week
 * @param {object[]} p.shipments        NormalizedShipment[] for those orders (any ship date)
 * @param {object[]} [p.hpdOrders]      NormalizedHpdOrder[]
 * @param {object} p.catalog            { rev, tables, mcgExtra?, overrides? }
 * @param {object} [p.policy]           ShipStation expense policy
 * @param {object} [p.previous]         previous week's PUBLISHED snapshot { weekStart, snapshotId, status, totals }
 * @param {object} [p.previousDraft]    previous week's latest unpublished snapshot (admin preview only)
 */
export function buildSnapshot({ weekStart, orders, shipments, hpdOrders = [], catalog, policy = DEFAULT_EXPENSE_POLICY, previous = null, previousDraft = null }) {
  const { rows, keys } = toLegacyShopifyRows(orders);
  const ssCosts = toLegacyShipStationCosts(shipments, policy);
  const hpdMap = hpdOrders.length ? toLegacyHpdMap(hpdOrders) : null;
  const a = engineArgsFromCatalog(catalog);

  const engineLines = calculate(rows, ssCosts, a.mcgCosts, a.productCosts, a.skuWeights, a.additionalCosts,
    a.hpByName, a.skuAlias, hpdMap, a.mcgExtra, a.vendorCosts, a.vendorIndex);
  const summary = summarize(engineLines);
  const keyed = attachLineKeys(engineLines, rows, keys);
  const contract = applyAllocationContract(keyed, orders);
  const shipping = diagnoseShipping(contract.lines, shipments, hpdMap, policy, new Map(orders.map(o => [o.orderName, o])));
  const { totals, breakdowns } = computeMetrics({ lines: contract.lines, summary, shipping });
  const orderRows = orderResults(contract.lines, shipping.orders);

  // ── Reconciliation ──
  const engineOrders = new Set(engineLines.map(l => l.orderNum));
  const srcNet = r2(orders.filter(o => engineOrders.has(o.orderName))
    .reduce((s, o) => s + (o.total || 0) - (o.taxes || 0) - ((o.refundedAmount || 0) > 0 ? o.refundedAmount : 0), 0));
  const product = contract.lines.filter(l => l.isProductLine);
  const giftCogs = r2(contract.lines.filter(l => l.isGiftCard).reduce((s, l) => s + (l.lineCogs || 0), 0));
  const ssSplit = r2(summary.shipByVendor.ShipStation.paid + summary.shipByVendor['HP Dropship'].paid);
  const engineSsByOrder = new Map(contract.lines.filter(l => l.orderCat && l.orderCat !== 'Pure HP Dropship').map(l => [l.orderNum, l.shipPaidSS || 0]));
  const ssMismatch = shipping.orders.filter(o => engineSsByOrder.has(o.orderName) && Math.abs((engineSsByOrder.get(o.orderName) || 0) - o.shipStationExpense) > 0.005).length;

  const reconciliation = [
    check('route_net_zero', 0, totals.routeNet),
    check('route_collected_equals_remitted', totals.routeCollected, totals.routeRemitted),
    check('no_route_in_product_measures', 0, product.filter(l => l.isRoute).length),
    check('shopify_net_revenue_ties_to_orders', srcNet, totals.shopifyNetRevenueInclPassThrough),
    check('operating_revenue_identity', totals.shopifyNetRevenueInclPassThrough - totals.routeCollected, totals.operatingRevenue),
    check('cogs_partition', summary.totalCogs, totals.knownProductCogs + totals._internal.routeForcedCogs + giftCogs),
    check('shipping_split', summary.totalShipPaid, ssSplit),
    check('shipstation_expense_matches_selection', 0, ssMismatch),
    check('operating_gp_identity', totals.operatingRevenue - totals.knownProductCogs - totals.shippingExpense, totals.operatingGpAfterShipping),
    check('known_cost_partition', r2(product.reduce((s, l) => s + l.contractRevenue, 0)), totals.knownCostProductRevenue + totals.missingCostRevenue),
  ];

  // ── Revenue bridge: product revenue + shipping collected vs tax-excluded order revenue ──
  const byName = new Map(orders.map(o => [o.orderName, o]));
  let prepaidSubShipping = 0, refundsBeyondProduct = 0;
  for (const l of engineLines) {
    if (!l.orderCat) continue;
    const o = byName.get(l.orderNum);
    prepaidSubShipping = r2(prepaidSubShipping - ((o?.shipping || 0) - (l.shipCollected || 0)));
    refundsBeyondProduct = r2(refundsBeyondProduct + (l.refundBeyondProduct || 0));
  }
  const provenDiscount = r2(contract.orders.filter(x => x.residualClass === 'proven_product_discount').reduce((s, x) => s + x.merchResidual, 0));
  const unprovenResidual = r2(contract.orders.filter(x => x.residualClass === 'unproven').reduce((s, x) => s + x.merchResidual, 0));
  const difference = r2(summary.productRevenue + summary.totalShipCollected - summary.totalRevenue);
  const explained = r2(provenDiscount + unprovenResidual + refundsBeyondProduct + prepaidSubShipping);
  const revenueBridge = {
    productRevenueEngine: r2(summary.productRevenue),
    shippingCollected: r2(summary.totalShipCollected),
    taxExcludedOrderRevenue: r2(summary.totalRevenue),
    difference,
    components: {
      orderLevelProductDiscountsProven: provenDiscount,
      orderLevelResidualUnproven: unprovenResidual,
      refundsBeyondProductRevenue: refundsBeyondProduct,
      prepaidSubscriptionShippingFutureMonths: prepaidSubShipping,
    },
    unexplainedResidual: r2(difference - explained),
  };
  reconciliation.push(check('revenue_bridge_residual', 0, revenueBridge.unexplainedResidual, { blocking: false }));

  const issues = {
    missingShipping: shipping.orders.filter(o => o.requiresShipStationRate && !o.hasValidShipStationRate)
      .map(o => ({ orderName: o.orderName, orderCat: o.orderCat, reason: o.missingReason, shipCollected: o.shipCollected,
                   operatingRevenue: orderRows.find(r => r.orderName === o.orderName)?.operatingRevenue ?? null })),
    missingCost: product.filter(l => l.lineCogs === null || l.lineCogs === undefined)
      .map(l => ({ orderName: l.orderNum, lineIndex: l.lineIndex, sku: l.sku, vendor: l.vendorKey || l.vendor, qty: l.qty, revenue: l.contractRevenue })),
    unallocatedResiduals: contract.orders.filter(x => Math.abs(x.residualUnallocated) > 0.005)
      .map(x => ({ orderName: x.orderName, residual: x.residualUnallocated, classification: x.residualClass })),
    unmatchedShipments: shipping.unmatchedShipments,
    // Orders with no SKU line (reship fees, expedite fees, some gift cards) produce
    // no engine lines, so today's calculator leaves their revenue out entirely.
    // Listed here so the gap is visible; changing it is a financial-logic decision.
    ordersExcludedByEngine: orders
      .filter(o => !engineOrders.has(o.orderName) && !o.cancelledAt)
      .map(o => ({ orderName: o.orderName, taxExcludedTotal: r2((o.total || 0) - (o.taxes || 0) - (o.refundedAmount || 0)),
                   lines: (o.lines || []).map(l => l.productName).slice(0, 3) })),
  };

  const snap = {
    weekStart, weekEnd: weekStart ? addDays(weekStart, 6) : null,
    engineVersion: ENGINE_VERSION,
    catalogRev: catalog?.rev || null,
    policy: { ...policy },
    profitabilityStatus: totals.profitabilityStatus,
    totals, breakdowns, reconciliation, revenueBridge, issues,
    orders: orderRows,
    lines: contract.lines.map(l => ({
      orderName: l.orderNum, lineIndex: l.lineIndex, sku: l.sku, product: l.product,
      vendorKey: l.vendorKey || null, channel: l.isSubRenewal ? 'Subscription renewals (prepaid)' : (l.source || null),
      store: l.store, qty: l.qty, unitPrice: l.unitPrice, unitCost: l.unitCost,
      contractRevenue: l.contractRevenue, lineCogs: l.lineCogs,
      knownCostGp: l.isProductLine && l.lineCogs !== null ? r2(l.contractRevenue - l.lineCogs) : null,
      costSource: l.costSource, costMatchType: l.costMatchType, missingCost: !!l.missingCost,
      discountAllocated: l.discountAllocated, discountSource: l.discountSource,
      refundAllocated: l.refundAllocatedContract, refundSource: l.refundSource,
      routeCollected: l.routeCollected, routeRemitted: l.routeRemitted,
      flags: { isRoute: !!l.isRoute, isGiftCard: !!l.isGiftCard, isDigital: !!l.isDigital, isSubRenewal: !!l.isSubRenewal,
               isInfluencerSample: !!l.isInfluencerSample, isProductLine: !!l.isProductLine },
    })),
    shipping: { coverage: shipping.coverage },
  };
  delete snap.totals._internal;
  snap.narrative = buildNarrative(snap, previous);
  snap.draftComparison = draftComparison(snap, previousDraft);
  return snap;
}
