/**
 * shippingPolicy.js — Revision 9 C3 order-level shipping classification
 * ====================================================================
 * Pure. Runs after calculate() on the same Shopify rows, with the Shipping Cost
 * Report aggregated per order. It never changes an amount: it explains which
 * orders need a ShipStation cost, which have one, why an order shows $0
 * customer shipping, and where a week sits in the provisional lifecycle.
 *
 *   Order-level coverage   matched ÷ expected ShipStation orders. Excluded (with
 *                          a reason) are Pure HP Dropship, Lively Root (Shopify
 *                          Collective), cancelled before fulfilment, no shipping
 *                          required, and orders without a SKU line. A cancelled
 *                          order that cannot be proven either way is
 *                          `cancelled_shipping_status_unverified`, never cleared.
 *   Zero-shipping classes  prepaid_subscription_fulfillment, free_shipping_promotion
 *                          (MCG products only, net merchandise ≥ threshold),
 *                          vendor_free_shipping_legacy (before the vendor's
 *                          first_paid_shipping_date), customer_shipping_zero_other
 *                          (draft / influencer / marketplace), classification_unknown.
 *   Lifecycle              shipping_order_coverage_open | _updated | _complete.
 *                          Coverage is ORDER level: a partial shipment cannot be
 *                          verified, so partial_fulfillment_check_available and
 *                          partial_fulfillment_verification_complete are false and
 *                          `shipping_complete` is never produced.
 */
import { normalizeOrderNumber, CANCELLED_AFTER_SHIPPING_CATEGORY, LIVELY_ROOT_STORE } from './calculator.js';
import { canonicalVendor } from './vendorCosts.js';
import { addDays, r2 } from './normalized.js';

export const LIFECYCLE = Object.freeze({
  OPEN: 'shipping_order_coverage_open',
  UPDATED: 'shipping_order_coverage_updated',
  COMPLETE: 'shipping_order_coverage_complete',
});
/** Reserved: needs partial-shipment verification, which no source provides. Never produced. */
export const RESERVED_SHIPPING_COMPLETE = 'shipping_complete';
export const PUBLICATION_SHIPPING_STATUS = Object.freeze({
  PROVISIONAL: 'published_provisional_shipping',
  ORDER_COVERAGE_COMPLETE: 'published_order_coverage_complete',
  SHIPPING_COMPLETE: 'published_shipping_complete',            // unreachable today
});
export const COVERAGE_COMPLETE_LABEL = 'Order-level shipping coverage complete. Partial-shipment verification is unavailable.';

export const EXPECTATION = Object.freeze({
  EXPECTED: 'expected_shipstation',
  PURE_HPD: 'excluded:pure_hpd',
  COLLECTIVE: 'excluded:vendor_fulfilled_shopify_collective',
  CANCELLED_BEFORE_FULFILLMENT: 'excluded:cancelled_before_fulfillment',
  CANCELLED_UNVERIFIED: 'cancelled_shipping_status_unverified',
  NO_SHIPPING_REQUIRED: 'excluded:no_shipping_required',
  NO_SKU_LINE: 'excluded:no_sku_line',
});

export const ZERO_SHIPPING = Object.freeze({
  PREPAID_SUBSCRIPTION: 'prepaid_subscription_fulfillment',
  PROMOTION: 'free_shipping_promotion',
  VENDOR_LEGACY: 'vendor_free_shipping_legacy',
  OTHER: 'customer_shipping_zero_other',
  UNKNOWN: 'classification_unknown',
});

export const DEFAULT_POLICY_SETTINGS = Object.freeze({
  vendor_first_paid_shipping_dates: Object.freeze({ 'Air Plant Shop': '2026-08-14', 'Live to Give': '2026-09-15', 'Surfside Arrangement': '2026-09-15' }),
  mcg_free_shipping_threshold: 89,
  shipping_coverage_aging_days: 14,
});

const MCG_STORE = 'Succulents Box (17381)';
const HPD_MIXED = new Set(['Mixed (17381 + HP Dropship)', 'Mixed (HP + Free Ship)']);
const MARKETPLACES = new Set(['amazon', 'walmart', 'ebay', 'etsy', 'tiktok', 'sellbrite']);
const SUB_SKU = /^(SUB|GSUB)/i;
const HEAT_PACK = /heat\s*pack/i;
const money = v => { const n = Number(String(v ?? '').replace(/[$,]/g, '').trim()); return Number.isFinite(n) ? n : 0; };
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Vendor whose free-shipping policy (by cutoff date) an order line falls under, or null. */
function freeShipVendorOf(line, cutoffs) {
  for (const v of Object.keys(cutoffs)) {
    if (line.store === v || canonicalVendor(line.vendor) === v || canonicalVendor(line.store) === v) return v;
  }
  return null;
}

/** Group Shopify rows by order (first row carries the order-level fields). */
function ordersFromRows(rows) {
  const m = new Map();
  for (const r of rows) {
    const name = String(r['Name'] || '').trim();
    if (!name) continue;
    if (!m.has(name)) m.set(name, { name, first: r, lines: [] });
    m.get(name).lines.push(r);
  }
  return m;
}

/**
 * The revised display category: the engine's "Free Ship" categories keep their
 * name only while a vendor's free shipping was in effect on the order date.
 * Expense rules follow the engine category and are unchanged.
 */
export function revisedCategory(orderCat, freeShipVendorsInEffect) {
  if (!orderCat || !/Free Ship/.test(orderCat) || freeShipVendorsInEffect) return orderCat;
  return orderCat.replace('Pure Free Ship', 'Pure Vendor (paid shipping)').replace('Free Ship)', 'Vendor)');
}

/**
 * @param {object} p
 * @param {object[]} p.rows        Shopify orders rows (legacy CSV shape) the engine received
 * @param {object[]} p.lines       calculate() output for those rows
 * @param {Map}      p.reportAgg   orderKey → { costCents, rowCount, firstShipDate, lastShipDate } (Shipping Cost Report)
 * @param {object}   [p.settings]  policy settings (DEFAULT_POLICY_SETTINGS)
 * @param {object}   [p.period]    { from, to } business dates (inclusive); orders outside are ignored
 */
export function classifyShipping({ rows, lines, reportAgg = new Map(), settings = {}, period = null }) {
  const cfg = { ...DEFAULT_POLICY_SETTINGS, ...settings };
  const cutoffs = cfg.vendor_first_paid_shipping_dates || {};
  const threshold = Number(cfg.mcg_free_shipping_threshold);
  const byOrder = ordersFromRows(rows);
  const engine = new Map();
  for (const l of lines) {
    const o = engine.get(l.orderNum) || { first: null, lines: [], stores: new Set() };
    if (l.orderCat && !o.first) o.first = l;
    o.lines.push(l); o.stores.add(l.store);
    engine.set(l.orderNum, o);
  }

  const orders = [];
  for (const [name, src] of byOrder) {
    const date = String(src.first['Created at'] || '').trim().slice(0, 10);
    if (period && (date < period.from || date > period.to)) continue;
    const key = normalizeOrderNumber(name);
    const e = engine.get(name);
    const report = reportAgg.get(key) || null;
    const hasCost = !!(report && report.costCents > 0);
    const cancelled = String(src.first['Cancelled at'] || src.first['Cancelled At'] || '').trim() !== '';
    const lineStatus = src.lines.map(r => String(r['Lineitem fulfillment status'] || '').trim().toLowerCase());
    const orderStatus = String(src.first['Fulfillment Status'] || '').trim().toLowerCase();
    const cat = e?.first?.orderCat || null;

    // ── Expectation ──
    let expectation;
    if (!e) {
      if (!cancelled) expectation = EXPECTATION.NO_SKU_LINE;
      else if (orderStatus !== 'fulfilled' && orderStatus !== 'partial' && lineStatus.every(s => s === 'pending' || s === 'restocked') && !report) expectation = EXPECTATION.CANCELLED_BEFORE_FULFILLMENT;
      else expectation = EXPECTATION.CANCELLED_UNVERIFIED;
    } else if (cat === CANCELLED_AFTER_SHIPPING_CATEGORY) expectation = EXPECTATION.EXPECTED;
    else if (e.stores.has(LIVELY_ROOT_STORE) && (cat === 'Other' || cat === 'Pure HP Dropship')) expectation = EXPECTATION.COLLECTIVE;
    else if (cat === 'Pure HP Dropship') expectation = EXPECTATION.PURE_HPD;
    else if (!src.lines.some(r => String(r['Lineitem requires shipping']).trim().toLowerCase() === 'true')) expectation = EXPECTATION.NO_SHIPPING_REQUIRED;
    else expectation = EXPECTATION.EXPECTED;

    // ── Zero customer shipping ──
    const shopifyShipping = money(src.first['Shipping']);
    let zeroShipping = null, zeroReason = null, freeShipVendors = [];
    const inEffect = [];
    if (e) {
      for (const l of e.lines) {
        const v = freeShipVendorOf(l, cutoffs);
        if (v && !freeShipVendors.includes(v)) freeShipVendors.push(v);
        if (v && date < cutoffs[v] && !inEffect.includes(v)) inEffect.push(v);
      }
    }
    if (e && !cancelled && shopifyShipping === 0) {
      const subLines = src.lines.filter(r => SUB_SKU.test(String(r['Lineitem sku'] || '').trim()));
      const tags = String(src.first['Tags'] || '').toLowerCase().split(',').map(t => t.trim());
      const source = String(src.first['Source'] || src.first['Source name'] || '').trim().toLowerCase();
      const subEvidence = tags.includes('prepaid') || tags.includes('subscription recurring order') || source === '294517';
      const mcgNet = r2(src.lines.filter(r => e.lines.some(l => l.sku === String(r['Lineitem sku'] || '').trim() && l.store === MCG_STORE))
        .reduce((s, r) => s + money(r['Lineitem price']) * (parseInt(r['Lineitem quantity'] || '1', 10) || 1) - money(r['Lineitem discount']), 0));
      const channel = String(e.first?.source || '').toLowerCase();
      if (subLines.length && subLines.every(r => money(r['Lineitem price']) === 0) && subEvidence) zeroShipping = ZERO_SHIPPING.PREPAID_SUBSCRIPTION;
      else if (Number.isFinite(threshold) && mcgNet >= threshold) zeroShipping = ZERO_SHIPPING.PROMOTION;
      else if (inEffect.length) zeroShipping = ZERO_SHIPPING.VENDOR_LEGACY;
      else if (source === 'shopify_draft_order') { zeroShipping = ZERO_SHIPPING.OTHER; zeroReason = 'draft'; }
      else if (e.lines.some(l => l.isInfluencerSample)) { zeroShipping = ZERO_SHIPPING.OTHER; zeroReason = 'influencer'; }
      else if (MARKETPLACES.has(channel) || MARKETPLACES.has(source)) { zeroShipping = ZERO_SHIPPING.OTHER; zeroReason = 'marketplace'; }
      else zeroShipping = ZERO_SHIPPING.UNKNOWN;
    }

    // ── Several report rows for one order ──
    let multiShipment = null;
    if (report && report.rowCount > 1) {
      const spread = dayDiff(report.firstShipDate, report.lastShipDate);
      const heatPack = src.lines.some(r => HEAT_PACK.test(String(r['Lineitem name'] || ''))) && src.lines.some(r => SUB_SKU.test(String(r['Lineitem sku'] || '').trim()));
      multiShipment = heatPack && spread > 1 ? 'heat_pack_delayed_shipment'          // cost stays on the original order
        : spread <= 3 ? 'split_shipment'
        : 'multiple_shipments_reason_unverified';
    }

    orders.push({
      orderName: name, orderKey: key, date, orderCat: cat,
      shippingCategory: revisedCategory(cat, inEffect.length > 0),
      expectation, expected: expectation === EXPECTATION.EXPECTED,
      matched: expectation === EXPECTATION.EXPECTED && hasCost,
      reportCostCents: report ? report.costCents : 0, reportRowCount: report ? report.rowCount : 0,
      mixedHpd: HPD_MIXED.has(cat),
      prepaidSubscription: zeroShipping === ZERO_SHIPPING.PREPAID_SUBSCRIPTION,
      zeroShipping, zeroShippingReason: zeroReason, freeShipVendors, freeShipVendorsInEffect: inEffect,
      multiShipment, partialFulfillment: orderStatus === 'partial',
      cancelledAfterShipping: cat === CANCELLED_AFTER_SHIPPING_CATEGORY,
    });
  }

  const count = f => orders.filter(f).length;
  const expected = count(o => o.expected), matched = count(o => o.matched);
  const excluded = {};
  for (const o of orders) if (!o.expected) excluded[o.expectation] = (excluded[o.expectation] || 0) + 1;
  const zero = {};
  for (const o of orders) if (o.zeroShipping) { const k = o.zeroShippingReason ? `${o.zeroShipping}:${o.zeroShippingReason}` : o.zeroShipping; zero[k] = (zero[k] || 0) + 1; }
  const multi = {};
  for (const o of orders) if (o.multiShipment) multi[o.multiShipment] = (multi[o.multiShipment] || 0) + 1;

  return {
    orders,
    coverage: { numerator: matched, denominator: expected, ratio: expected ? matched / expected : 1,
                expectedWithoutCost: expected - matched, excluded },
    counts: {
      matchedOrders: matched,
      expectedOrdersWithoutCost: expected - matched,
      pureHpdExclusions: excluded[EXPECTATION.PURE_HPD] || 0,
      mixedHpdOrders: count(o => o.mixedHpd),
      prepaidSubscriptionFulfillments: count(o => o.zeroShipping === ZERO_SHIPPING.PREPAID_SUBSCRIPTION),
      vendorPolicyFreeShippingOrders: count(o => o.zeroShipping === ZERO_SHIPPING.VENDOR_LEGACY),
      promotionalFreeShippingOrders: count(o => o.zeroShipping === ZERO_SHIPPING.PROMOTION),
      otherZeroShippingOrders: count(o => o.zeroShipping === ZERO_SHIPPING.OTHER),
      unclassifiedZeroShippingOrders: count(o => o.zeroShipping === ZERO_SHIPPING.UNKNOWN),
      cancelledAfterShippingOrders: count(o => o.cancelledAfterShipping),
      cancelledStatusUnverified: excluded[EXPECTATION.CANCELLED_UNVERIFIED] || 0,
      partialFulfillmentOrders: count(o => o.partialFulfillment),
    },
    zeroShippingClasses: zero,
    multiShipment: multi,
  };
}

/**
 * Where a week sits. Complete = every expected order has a cost, or the aging
 * limit has passed (remaining orders are listed as aged without cost).
 */
export function shippingLifecycle({ coverage, weekEnd, asOf, previousShippingExpense = null, shippingExpense = null, agingDays = DEFAULT_POLICY_SETTINGS.shipping_coverage_aging_days }) {
  const agingEnds = weekEnd ? addDays(weekEnd, Number(agingDays)) : null;
  const aged = !!(agingEnds && asOf && String(asOf).slice(0, 10) > agingEnds);
  let status;
  if (coverage.expectedWithoutCost === 0 || aged) status = LIFECYCLE.COMPLETE;
  else if (previousShippingExpense !== null && shippingExpense !== null && Math.abs(previousShippingExpense - shippingExpense) > 0.005) status = LIFECYCLE.UPDATED;
  else status = LIFECYCLE.OPEN;
  return {
    status, agingEnds, agedWithoutCost: status === LIFECYCLE.COMPLETE && coverage.expectedWithoutCost > 0 ? coverage.expectedWithoutCost : 0,
    partial_fulfillment_check_available: false,
    partial_fulfillment_verification_complete: false,
    label: status === LIFECYCLE.COMPLETE ? COVERAGE_COMPLETE_LABEL
      : `Order-level shipping coverage open: ${coverage.expectedWithoutCost} of ${coverage.denominator} orders still need a ShipStation cost (until ${agingEnds || 'the aging limit'}).`,
  };
}

/** Which publication status a snapshot could carry; null = not publishable on shipping grounds. */
export function publicationShippingStatus({ sourceVerified, provisionalEnabled, lifecycleStatus, partialVerificationComplete = false }) {
  if (sourceVerified && lifecycleStatus === LIFECYCLE.COMPLETE) {
    return partialVerificationComplete ? PUBLICATION_SHIPPING_STATUS.SHIPPING_COMPLETE : PUBLICATION_SHIPPING_STATUS.ORDER_COVERAGE_COMPLETE;
  }
  return provisionalEnabled ? PUBLICATION_SHIPPING_STATUS.PROVISIONAL : null;
}

/**
 * The disclosure block shown with every C3 result. Product-cost completeness
 * and shipping-source verification are separate statuses.
 */
export function shippingDisclosures({ catalogRev, missingCostLines, missingCostRevenue, sourceVerified, lifecycle, publicationAllowed = false }) {
  return {
    provisional: true,
    catalogVersion: catalogRev || null,
    productCost: { status: missingCostLines > 0 ? 'incomplete' : 'complete', missingCostLines, missingCostRevenue: r2(missingCostRevenue || 0),
                   label: missingCostLines > 0 ? `Product-cost catalog incomplete: ${missingCostLines} lines without cost` : 'Product costs complete' },
    shippingSource: { source: 'shipstation_shipping_cost_report', status: sourceVerified ? 'verified' : 'unverified',
                      label: sourceVerified ? 'Shipping source verified' : 'Shipping source unverified' },
    shippingCoverage: lifecycle,
    publication: publicationAllowed ? 'enabled' : 'disabled',
    labels: ['Provisional', sourceVerified ? 'Shipping source verified' : 'Shipping source unverified',
             missingCostLines > 0 ? 'Product-cost catalog incomplete' : 'Product costs complete',
             ...(missingCostLines > 0 ? [`${missingCostLines} lines missing product cost`] : []),
             publicationAllowed ? 'Publication enabled' : 'Publication disabled'],
  };
}
