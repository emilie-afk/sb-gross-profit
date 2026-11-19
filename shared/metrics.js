/**
 * metrics.js — the Revision 5 metric dictionary
 * =============================================
 * Computed from calculate() output after the allocation contract. Nothing here
 * changes the legacy engine or the live dashboard; the Worker stores these on
 * every snapshot.
 *
 *   Operating revenue            = Shopify net revenue including pass-through − Route collected
 *   Shopify net revenue incl.    = Σ (Total − Taxes − Refunded Amount)        [reconciliation only]
 *   Operating GP after shipping  = operating revenue − known product COGS − shipping expense
 *   Known-cost product GP        = revenue of product lines with a valid cost − their COGS
 *
 * A missing cost is never zero. When any product line lacks cost, or any order
 * that needs a ShipStation cost lacks one, results are labelled provisional.
 */
import { SUB_RENEWAL_CHANNEL } from './calculator.js';
import { normalizeSku } from './vendorCosts.js';
import { r2 } from './normalized.js';

export const PROFITABILITY_STATUS = Object.freeze({
  COMPLETE:                         'complete',
  PROVISIONAL_MISSING_COSTS:        'provisional_missing_costs',
  PROVISIONAL_MISSING_SHIPPING:     'provisional_missing_shipping',
  PROVISIONAL_MISSING_COSTS_AND_SHIPPING: 'provisional_missing_costs_and_shipping',
  // Costs and ShipStation expense are complete, but some HP Dropship shipping is
  // an ASSUMED pass-through (Shopify shipping collected), not an HPD actual.
  // Whether that may count as complete is an open business decision; until it
  // is approved (a deliberate code change), it never does.
  PROVISIONAL_HPD_PASS_THROUGH:     'provisional_hpd_pass_through',
});

/**
 * @param {boolean} costsComplete
 * @param {boolean} shippingComplete   every order needing a ShipStation cost has one
 * @param {boolean} [hpdAssumed]       some HPD shipping is pass-through, not actual
 */
export function profitabilityStatus(costsComplete, shippingComplete, hpdAssumed = false) {
  if (costsComplete && shippingComplete) return hpdAssumed ? PROFITABILITY_STATUS.PROVISIONAL_HPD_PASS_THROUGH : PROFITABILITY_STATUS.COMPLETE;
  if (!costsComplete && !shippingComplete) return PROFITABILITY_STATUS.PROVISIONAL_MISSING_COSTS_AND_SHIPPING;
  return costsComplete ? PROFITABILITY_STATUS.PROVISIONAL_MISSING_SHIPPING : PROFITABILITY_STATUS.PROVISIONAL_MISSING_COSTS;
}

export const fmtUsd = n => (n < 0 ? '−$' : '$') + Math.abs(r2(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

function emptyBucket(key) {
  return { key, units: 0, lines: 0, knownCostRevenue: 0, knownCogs: 0, knownCostGp: 0,
           missingCostRevenue: 0, missingCostUnits: 0, missingCostLines: 0 };
}

function finishBucket(b) {
  b.knownCostRevenue = r2(b.knownCostRevenue); b.knownCogs = r2(b.knownCogs);
  b.knownCostGp = r2(b.knownCostRevenue - b.knownCogs);
  b.missingCostRevenue = r2(b.missingCostRevenue);
  b.knownCostMargin = pct(b.knownCostGp, b.knownCostRevenue);
  b.costCoverageByRevenue = pct(b.knownCostRevenue, b.knownCostRevenue + b.missingCostRevenue);
  b.costCoverageByUnits = pct(b.units - b.missingCostUnits, b.units);
  b.coverageStatus = b.missingCostLines ? 'incomplete' : 'complete';
  b.gpLabel = b.missingCostLines ? 'Known-cost product GP' : 'Product GP';
  b.coverageLabel = b.missingCostLines ? 'Incomplete cost coverage' : null;
  return b;
}

const channelOf = li => (li.isSubRenewal ? SUB_RENEWAL_CHANNEL : (li.source || 'Unknown'));
const vendorOf  = li => li.vendorKey || (li.vendor || '').trim() || 'Unknown';

/**
 * @param {object} p
 * @param {object[]} p.lines        contract lines (applyAllocationContract().lines)
 * @param {object}   p.summary      summarize() of the same engine lines
 * @param {object}   p.shipping     diagnoseShipping() result
 */
export function computeMetrics({ lines, summary, shipping }) {
  const product = lines.filter(l => l.isProductLine);
  const route = lines.filter(l => l.isRoute);

  const routeCollected = r2(route.reduce((s, l) => s + (l.routeCollected || 0), 0));
  const routeRemitted  = r2(route.reduce((s, l) => s + (l.routeRemitted || 0), 0));
  const routeNet       = r2(routeCollected - routeRemitted);
  const routeForcedCogs = r2(route.reduce((s, l) => s + (l.lineCogs || 0), 0));

  const shopifyNetRevenueInclPassThrough = r2(summary.totalRevenue);
  const operatingRevenue = r2(shopifyNetRevenueInclPassThrough - routeCollected);

  const known   = product.filter(l => l.lineCogs !== null && l.lineCogs !== undefined);
  const missing = product.filter(l => l.lineCogs === null || l.lineCogs === undefined);
  const knownProductCogs     = r2(known.reduce((s, l) => s + l.lineCogs, 0));
  const knownCostProductRevenue = r2(known.reduce((s, l) => s + l.contractRevenue, 0));
  const knownCostProductGp   = r2(knownCostProductRevenue - knownProductCogs);
  const missingCostRevenue   = r2(missing.reduce((s, l) => s + l.contractRevenue, 0));
  const missingCostUnits     = missing.reduce((s, l) => s + (l.qty || 0), 0);
  const missingCostLines     = missing.length;
  const productUnits         = product.reduce((s, l) => s + (l.qty || 0), 0);

  const shippingExpense   = r2(summary.totalShipPaid);
  const shippingCollected = r2(summary.totalShipCollected);
  const operatingGp       = r2(operatingRevenue - knownProductCogs - shippingExpense);

  const cov = shipping.coverage;
  const costsComplete = missingCostLines === 0;
  const shippingComplete = cov.ordersWithValidShipStationRate === cov.ordersRequiringShipStationRate;
  const hpdAssumed = (cov.hpdOrdersPassThrough || 0) > 0;
  const status = profitabilityStatus(costsComplete, shippingComplete, hpdAssumed);
  const hpdShippingBasis = !cov.hpdOrdersActual && !cov.hpdOrdersPassThrough ? 'none'
    : !cov.hpdOrdersPassThrough ? 'hpd_actual'
    : !cov.hpdOrdersActual ? 'hpd_pass_through_assumed' : 'mixed_hpd_actual_and_assumed';
  const provisional = status !== PROFITABILITY_STATUS.COMPLETE;
  const missingShippingOrders = cov.ordersRequiringShipStationRate - cov.ordersWithValidShipStationRate;

  const notes = [];
  if (!costsComplete) notes.push(`Excludes unknown COGS on ${fmtUsd(missingCostRevenue)} of product revenue (${missingCostLines} line${missingCostLines === 1 ? '' : 's'})`);
  if (!shippingComplete) notes.push(`Excludes shipping expense on ${missingShippingOrders} order${missingShippingOrders === 1 ? '' : 's'} that require a ShipStation cost`);
  if (cov.hpdOrdersPassThrough) notes.push(`Assumes HP Dropship shipping expense equals Shopify shipping collected on ${cov.hpdOrdersPassThrough} order${cov.hpdOrdersPassThrough === 1 ? '' : 's'} (pass-through; HPD actuals not received)`);

  // ── Breakdowns (product lines only; Route and gift cards never appear) ──
  const dims = { channel: channelOf, vendor: vendorOf, store: l => l.store || 'Unknown',
                 sku: l => `${vendorOf(l)}|${normalizeSku(l.sku)}` };
  const breakdowns = {};
  for (const [dim, keyOf] of Object.entries(dims)) {
    const m = new Map();
    for (const l of product) {
      const k = keyOf(l);
      if (!m.has(k)) m.set(k, { ...emptyBucket(k), ...(dim === 'sku' ? { sku: l.sku, vendor: vendorOf(l), product: l.product } : {}) });
      const b = m.get(k);
      b.units += l.qty || 0; b.lines++;
      if (l.lineCogs === null || l.lineCogs === undefined) {
        b.missingCostRevenue += l.contractRevenue; b.missingCostUnits += l.qty || 0; b.missingCostLines++;
      } else { b.knownCostRevenue += l.contractRevenue; b.knownCogs += l.lineCogs; }
    }
    breakdowns[dim] = [...m.values()].map(finishBucket).sort((a, b) => b.knownCostRevenue - a.knownCostRevenue);
  }

  const totals = {
    operatingRevenue,
    shopifyNetRevenueInclPassThrough,
    operatingGpAfterShipping: operatingGp,
    operatingGpMargin: pct(operatingGp, operatingRevenue),
    routeCollected, routeRemitted, routeNet,
    knownProductCogs,
    knownCostProductRevenue, knownCostProductGp,
    knownCostProductMargin: pct(knownCostProductGp, knownCostProductRevenue),
    missingCostRevenue, missingCostUnits, missingCostLines,
    costCoverageByRevenue: pct(knownCostProductRevenue, knownCostProductRevenue + missingCostRevenue),
    costCoverageByUnits: pct(productUnits - missingCostUnits, productUnits),
    shippingCollected, shippingExpense,
    shipStationExpense: r2(summary.shipByVendor?.ShipStation?.paid ?? 0),
    hpdShippingExpense: r2(summary.shipByVendor?.['HP Dropship']?.paid ?? 0),
    ordersRequiringShipStationRate: cov.ordersRequiringShipStationRate,
    ordersWithValidShipStationRate: cov.ordersWithValidShipStationRate,
    shipStationExpenseCoverage: pct(cov.ordersWithValidShipStationRate, cov.ordersRequiringShipStationRate),
    hpdOrdersActual: cov.hpdOrdersActual,
    hpdOrdersPassThrough: cov.hpdOrdersPassThrough,
    hpdShippingBasis,
    insuranceDisclosed: cov.insuranceDisclosedTotal,
    profitabilityStatus: status,
    labels: {
      headline: provisional ? 'Provisional operating GP after shipping' : 'Operating GP after shipping',
      productGp: costsComplete ? 'Product GP' : 'Known-cost product GP',
      costCoverage: costsComplete ? 'Complete cost coverage' : 'Incomplete cost coverage',
      hpdShipping: { hpd_actual: 'HPD actual shipping', hpd_pass_through_assumed: 'HPD shipping assumed (pass-through)',
                     mixed_hpd_actual_and_assumed: 'HPD shipping partly assumed (pass-through)', none: null }[hpdShippingBasis],
      hpdShippingBasis,
      notes,
    },
    _internal: { routeForcedCogs },
  };
  return { totals, breakdowns };
}

/** Per-order results for the order table and the order detail route. */
export function orderResults(lines, shippingOrders) {
  const diag = new Map(shippingOrders.map(o => [o.orderName, o]));
  const m = new Map();
  for (const l of lines) {
    if (!m.has(l.orderNum)) m.set(l.orderNum, { orderName: l.orderNum, date: l.date, channel: l.source || null,
      shopifyNetRevenue: 0, routeCollected: 0, knownProductCogs: 0, missingCostLines: 0, lineCount: 0 });
    const o = m.get(l.orderNum);
    o.lineCount++;
    o.shopifyNetRevenue = r2(o.shopifyNetRevenue + (l.orderTotal || 0));
    o.routeCollected = r2(o.routeCollected + (l.routeCollected || 0));
    if (l.isProductLine) {
      if (l.lineCogs === null || l.lineCogs === undefined) o.missingCostLines++;
      else o.knownProductCogs = r2(o.knownProductCogs + l.lineCogs);
    }
  }
  return [...m.values()].map(o => {
    const d = diag.get(o.orderName) || {};
    const operatingRevenue = r2(o.shopifyNetRevenue - o.routeCollected);
    const shipPaid = d.shipPaid ?? null;
    return {
      ...o,
      orderCat: d.orderCat ?? null,
      operatingRevenue,
      shipCollected: d.shipCollected ?? null,
      shipPaid, shipPaidSS: d.shipPaidSS ?? null, shipPaidHP: d.shipPaidHP ?? null,
      operatingGp: r2(operatingRevenue - o.knownProductCogs - (shipPaid || 0)),
      requiresShipStationRate: d.requiresShipStationRate ?? null,
      hasValidShipStationRate: d.hasValidShipStationRate ?? null,
      shippingExpenseSource: d.shippingExpenseSource ?? null,
      shippingExpenseStatus: d.shippingExpenseStatus ?? null,
      missingReason: d.missingReason ?? null,
      hpdShippingBasis: d.shippingExpenseStatus === 'pass_through' ? 'hpd_pass_through_assumed'
        : (d.hpdActual === true ? 'hpd_actual' : null),
      profitabilityStatus: profitabilityStatus(o.missingCostLines === 0,
        !(d.requiresShipStationRate && !d.hasValidShipStationRate), d.shippingExpenseStatus === 'pass_through'),
    };
  });
}
