/**
 * unmatchedShipping.js — Shipping Cost Report orders that join no Shopify order
 * ============================================================================
 * C3 correction. Pure; used by the dashboard's Shipping Analysis and the tests.
 *
 * An unmatched report order is EXCLUDED from GP ("Excluded pending order
 * match"): its cost is never assigned to the current period. When a later
 * Shopify export contains the order, the order joins and its own week is
 * recomputed (the Worker drafts a revision; published snapshots never change).
 *
 * Reasons (per order, from its report rows' SHIP dates and the Shopify export
 * period — never from order-number ranges):
 *   Invalid order number          the Order # is not a Shopify order number
 *   Before Shopify export period  a package shipped before the export period
 *                                 began, so the order was created before it
 *   After Shopify export period   every package shipped after the export period ended
 *   Not found in Shopify export   a package shipped inside the export period but
 *                                 the order is not in the export (created earlier,
 *                                 or missing from the export — cannot tell)
 *   Requires review               packages on both sides of the period, review
 *                                 amounts (insurance, duties, taxes, import fee),
 *                                 or no export period to compare with
 *
 * The export period is the explicitly requested one when given, otherwise the
 * first and last order dates in the uploaded Shopify export.
 *
 * Only order number, ship date, Shipping Cost, row count, Provider and Service
 * are ever read or returned: no Recipient, Shipping Paid or customer data.
 */
import { CANCELLED_AFTER_SHIPPING_CATEGORY } from './calculator.js';

export const UNMATCHED_REASON = Object.freeze({
  BEFORE: 'Before Shopify export period',
  AFTER: 'After Shopify export period',
  NOT_FOUND: 'Not found in Shopify export',
  INVALID: 'Invalid order number',
  REVIEW: 'Requires review',
});
export const EXCLUDED_PENDING_MATCH = 'Excluded pending order match';
export const UNMATCHED_CSV_COLUMNS = Object.freeze(['ShipStation order number', 'Ship date', 'Shipping cost', 'Report rows', 'Provider', 'Service', 'Match status', 'Reason detail']);

const money = c => (Math.round(c) / 100).toFixed(2);
const uniq = a => [...new Set(a.filter(Boolean))];

/** The period to compare ship dates with. */
export function exportPeriodOf(orderRows, requested = null) {
  if (requested?.from && requested?.to) return { from: requested.from, to: requested.to, basis: 'requested_export_period' };
  const dates = (orderRows || []).map(r => String(r['Created at'] || '').trim().slice(0, 10)).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  return dates.length ? { from: dates[0], to: dates[dates.length - 1], basis: 'shopify_order_dates' } : { from: null, to: null, basis: 'none' };
}

/**
 * @param {object}   p
 * @param {object[]} p.reportRows        parsed report rows ({ orderKey, shipDate, shippingCostCents, provider, service, …Cents })
 * @param {object[]} [p.invalidOrderRows] rows whose Order # is not a Shopify order number
 * @param {Set}      p.shopifyOrderKeys  order numbers present in the uploaded Shopify export
 * @param {object}   p.exportPeriod      exportPeriodOf()
 */
export function unmatchedShippingOrders({ reportRows, invalidOrderRows = [], shopifyOrderKeys, exportPeriod }) {
  const byOrder = new Map();
  for (const r of reportRows) {
    if (shopifyOrderKeys.has(r.orderKey)) continue;
    if (!byOrder.has(r.orderKey)) byOrder.set(r.orderKey, []);
    byOrder.get(r.orderKey).push(r);
  }
  const { from, to } = exportPeriod || {};
  const orders = [];
  for (const [key, rows] of byOrder) {
    const sorted = [...rows].sort((a, b) => (a.shipDate < b.shipDate ? -1 : a.shipDate > b.shipDate ? 1 : a.rowSeq - b.rowSeq));
    const before = sorted.some(r => from && r.shipDate < from), after = sorted.some(r => to && r.shipDate > to);
    const inside = sorted.some(r => from && to && r.shipDate >= from && r.shipDate <= to);
    const reviewAmounts = sorted.some(r => [r.insuranceCents, r.dutiesCents, r.taxesCents, r.importFeeCents].some(v => v));
    let reason, detail;
    if (!from || !to) { reason = UNMATCHED_REASON.REVIEW; detail = 'No Shopify export period to compare with'; }
    else if (reviewAmounts) { reason = UNMATCHED_REASON.REVIEW; detail = 'Insurance, duties, taxes or import fee on a package'; }
    else if (before && after) { reason = UNMATCHED_REASON.REVIEW; detail = 'Packages shipped both before and after the export period'; }
    else if (before) { reason = UNMATCHED_REASON.BEFORE; detail = `Shipped before ${from}, so created before the export period`; }
    else if (inside) { reason = UNMATCHED_REASON.NOT_FOUND; detail = `Shipped within ${from}–${to} but not in the export`; }
    else { reason = UNMATCHED_REASON.AFTER; detail = `Every package shipped after ${to}`; }
    orders.push(orderRecord(key, sorted, reason, detail));
  }
  // Invalid order numbers: one entry per distinct value, never costed.
  const inv = new Map();
  for (const r of invalidOrderRows) { const k = r.orderNumber || '(blank)'; if (!inv.has(k)) inv.set(k, []); inv.get(k).push(r); }
  for (const [k, rows] of inv) orders.push(orderRecord(k, [...rows].sort((a, b) => (a.shipDate < b.shipDate ? -1 : 1)), UNMATCHED_REASON.INVALID, 'Order # is not a Shopify order number'));

  orders.sort((a, b) => (a.firstShipDate < b.firstShipDate ? -1 : a.firstShipDate > b.firstShipDate ? 1 : a.orderNumber < b.orderNumber ? -1 : 1));
  return { orders, summary: summarizeUnmatched(orders), exportPeriod, label: EXCLUDED_PENDING_MATCH };
}

function orderRecord(orderNumber, rows, reason, detail) {
  return {
    orderNumber, reason, detail, status: EXCLUDED_PENDING_MATCH,
    firstShipDate: rows[0].shipDate, lastShipDate: rows[rows.length - 1].shipDate,
    costCents: rows.reduce((s, r) => s + r.shippingCostCents, 0), rowCount: rows.length,
    providers: uniq(rows.map(r => r.provider)), services: uniq(rows.map(r => r.service)),
    rows: rows.map(r => ({ shipDate: r.shipDate, costCents: r.shippingCostCents, provider: r.provider || '', service: r.service || '' })),
  };
}

export function summarizeUnmatched(orders) {
  const by = Object.fromEntries(Object.values(UNMATCHED_REASON).map(r => [r, { orders: 0, costCents: 0 }]));
  for (const o of orders) { by[o.reason].orders++; by[o.reason].costCents += o.costCents; }
  const total = { orders: orders.length, costCents: orders.reduce((s, o) => s + o.costCents, 0) };
  const sum = Object.values(by).reduce((a, v) => ({ orders: a.orders + v.orders, costCents: a.costCents + v.costCents }), { orders: 0, costCents: 0 });
  return { total, byReason: by, reconciles: sum.orders === total.orders && sum.costCents === total.costCents };
}

/** Search by order number, filter by reason, sort by ship date or cost. */
export function filterUnmatched(orders, { search = '', reason = '', sortKey = 'shipDate', sortDir = 'asc' } = {}) {
  const q = String(search).trim().replace(/^#/, '').toLowerCase();
  const out = orders.filter(o => (!q || o.orderNumber.toLowerCase().includes(q)) && (!reason || o.reason === reason));
  const val = o => (sortKey === 'cost' ? o.costCents : o.firstShipDate);
  const dir = sortDir === 'desc' ? -1 : 1;
  return out.sort((a, b) => (val(a) < val(b) ? -dir : val(a) > val(b) ? dir : a.orderNumber < b.orderNumber ? -1 : 1));
}

const csvCell = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/** CSV of the listed orders; one line per order (ship dates as first–last). */
export function unmatchedCsv(orders) {
  const lines = [UNMATCHED_CSV_COLUMNS.join(',')];
  for (const o of orders) {
    lines.push([o.orderNumber, o.firstShipDate === o.lastShipDate ? o.firstShipDate : `${o.firstShipDate} to ${o.lastShipDate}`, money(o.costCents),
                o.rowCount, o.providers.join(' / '), o.services.join(' / '), `${o.reason} — ${o.status}`, o.detail].map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/**
 * Raw report cost → ShipStation cost included in GP, with no residual.
 *
 *   Raw report cost
 *   − unmatched cost (excluded pending order match)
 *   − documented exclusions: report cost on matched orders the engine does not
 *     expense as ShipStation (Pure HP Dropship, Lively Root pass-through,
 *     cancelled orders, orders with no SKU line) and on matched orders outside
 *     the reporting period
 *   = ShipStation cost included in GP (the engine's ShipStation expense)
 *
 * @param {object[]} p.reportRows, p.invalidOrderRows   as above
 * @param {object[]} p.lines        calculate() output for the uploaded orders
 * @param {object[]} p.orderRows    Shopify rows the engine received
 * @param {object}   p.unmatched    unmatchedShippingOrders()
 * @param {object}   [p.period]     reporting period { from, to }; orders outside are out of period
 */
export function shippingCostBridge({ reportRows, invalidOrderRows = [], lines, orderRows, unmatched, period = null }) {
  const cost = new Map();
  for (const r of reportRows) cost.set(r.orderKey, (cost.get(r.orderKey) || 0) + r.shippingCostCents);
  const rawCents = [...cost.values()].reduce((s, c) => s + c, 0) + invalidOrderRows.reduce((s, r) => s + r.shippingCostCents, 0);
  const unmatchedCents = unmatched.summary.total.costCents;

  const first = new Map(), date = new Map();
  for (const l of lines) if (l.orderCat && !first.has(l.orderNum)) first.set(l.orderNum.replace(/^#/, ''), l);
  for (const r of orderRows) { const k = String(r['Name'] || '').trim().replace(/^#/, ''); if (k && !date.has(k)) date.set(k, String(r['Created at'] || '').slice(0, 10)); }
  const cancelled = new Set(orderRows.filter(r => String(r['Cancelled at'] || '').trim()).map(r => String(r['Name']).trim().replace(/^#/, '')));

  const buckets = [
    ['out_of_period', 'Matched orders outside the reporting period'],
    ['pure_hpd', 'Pure HP Dropship orders (HPD pass-through, report cost not used)'],
    ['lively_root', 'Lively Root pass-through orders (report cost not used)'],
    ['cancelled', 'Cancelled orders excluded from profitability'],
    ['no_sku_line', 'Orders with no SKU line (not in the engine)'],
  ];
  const ex = Object.fromEntries(buckets.map(([code, label]) => [code, { code, label, orders: 0, costCents: 0 }]));
  let includedCents = 0;
  for (const [k, c] of cost) {
    if (!date.has(k)) continue;                                      // unmatched: counted above
    const l = first.get(k);
    const add = code => { ex[code].orders++; ex[code].costCents += c; };
    if (period && (date.get(k) < period.from || date.get(k) > period.to)) add('out_of_period');
    else if (!l) add(cancelled.has(k) ? 'cancelled' : 'no_sku_line');
    else if (l.orderCat === 'Pure HP Dropship') add('pure_hpd');
    else if (l.shipPaidLR !== null && l.shipPaidLR !== undefined) add('lively_root');
    else if (l.orderCat === CANCELLED_AFTER_SHIPPING_CATEGORY || !cancelled.has(k)) includedCents += c;
    else add('cancelled');
  }
  const inPeriod = l => !period || (l.date >= period.from && l.date <= period.to);
  const engineCents = Math.round(lines.filter(l => l.orderCat && inPeriod(l)).reduce((s, l) => s + (l.shipPaidSS || 0), 0) * 100);
  const exclusionCents = Object.values(ex).reduce((s, e) => s + e.costCents, 0);
  return {
    rawCents, unmatchedCents, exclusions: Object.values(ex), exclusionCents, includedCents, engineShipStationCents: engineCents,
    residualCents: rawCents - unmatchedCents - exclusionCents - engineCents,
  };
}
