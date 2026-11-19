/**
 * refunds.js — refunded orders and refund analysis, the same for CSV, weekly and monthly reports
 * ===============================================================================================
 * Input: line items in the calculator's shape (CSV: calculate(); automatic reports: storedLines()).
 * Refunds are ALREADY in those figures: line revenue is after its refund share and the order's net
 * revenue is after its refund. Nothing here subtracts a refund again; it only reads and groups them.
 *
 *   refundIndex(lines, opts)  → Map orderNum → { status: full | partial | none | unknown, refund, ... }
 *   refundSummary(index, lines) → counts, totals, by channel and vendor, costs kept on refunded orders
 *   matchesRefundFilter(status, filter)  'all' | 'refunded' | 'none'
 *
 * Per order:
 *   refund       CSV: Shopify's order-level Refunded Amount (first line's orderRefund).
 *                Stored: the refunds allocated to the order's lines (product and Route); a part refunded
 *                beyond product revenue (shipping, other) is in the week's totals but not per order,
 *                and is disclosed (refundsNotPerOrder).
 *   status       full when nothing of the order's net revenue is left, partial when a refund left some,
 *                none when the source records no refund, unknown when the source cannot say:
 *                CSV without a Refunded Amount column, or a stored order with no product revenue in a
 *                week that has refunds not attributed to orders. Unknown is never treated as none.
 * Refund date and reason are shown only when the source provides them (neither source does today).
 */
const c = x => Math.round((Number(x) || 0) * 100);
const d$ = n => Math.round(n) / 100;

export const REFUND_FILTERS = Object.freeze({ all: 'All orders', refunded: 'Refunded orders', none: 'Orders without refunds' });

export function matchesRefundFilter(status, filter) {
  if (!filter || filter === 'all') return true;
  if (filter === 'refunded') return status === 'full' || status === 'partial';
  if (filter === 'none') return status === 'none';                 // unknown is never "without refunds"
  return true;
}

/**
 * @param {object[]} lines
 * @param {object} [o]
 * @param {boolean} [o.refundKnown=true]  false when the source has no refund information at all (CSV without the column)
 */
export function refundIndex(lines, { refundKnown = true } = {}) {
  const groups = new Map();
  for (const li of lines) (groups.get(li.orderNum) || groups.set(li.orderNum, []).get(li.orderNum)).push(li);
  const out = new Map();
  for (const [orderNum, g] of groups) {
    const first = g.find(l => l.orderTotal !== undefined && (l.orderTotal !== 0 || l.shipCollected !== null)) || g[0];
    const lineRefunds = g.reduce((s, l) => s + c(l.refundAllocated), 0);
    const refundC = first.orderRefund !== undefined && first.orderRefund !== null ? c(first.orderRefund) : lineRefunds;
    const net = g.reduce((s, l) => s + c(l.orderTotal), 0);
    const unknown = !refundKnown || g.some(l => l.refundUnknown === true);
    const status = refundC > 0 ? (net <= 0 ? 'full' : 'partial') : (unknown ? 'unknown' : 'none');
    const route = g.filter(l => l.isRoute).reduce((s, l) => s + c(l.lineRevenue), 0);
    const knownCogs = g.filter(l => !l.isRoute && l.lineCogs !== null && l.lineCogs !== undefined).reduce((s, l) => s + c(l.lineCogs), 0);
    const missingLines = g.filter(l => l.costSource === 'COST MISSING').length;
    const netGp = first.orderOperatingGp !== undefined && first.orderOperatingGp !== null ? c(first.orderOperatingGp)
      : g.reduce((s, l) => s + (l.lineNetGp === null || l.lineNetGp === undefined ? 0 : c(l.lineNetGp)), 0);
    out.set(orderNum, {
      orderNum, date: first.date || null, channel: first.source || '', orderCat: first.orderCat || '',
      vendors: [...new Set(g.map(l => l.vendor || l.store).filter(Boolean))],
      status, refund: d$(refundC), lineRefunds: d$(lineRefunds),
      netRevenue: first.orderOperatingRevenue !== undefined && first.orderOperatingRevenue !== null ? first.orderOperatingRevenue : d$(net - route),
      knownCogs: d$(knownCogs), missingCostLines: missingLines,
      shipCollected: first.shipCollected ?? null, shipPaid: first.shipPaid ?? null, gp: d$(netGp),
      refundDate: first.refundDate || null, refundReason: first.refundReason || null,
    });
  }
  return out;
}

/** Counts, amounts and breakdowns of refunds over the orders of `index` (the period's orders). */
/**
 * @param {Map} index    refundIndex() of the period's orders
 * @param {object[]} lines
 * @param {object} [o]
 * @param {object} [o.notPerOrder]  automatic reports: { allocated, notPerOrder, total, boundary, complete } from
 *   storedReport.aggregate(). Per-order amounts are then ALLOCATED refunds (line shares); refunds beyond the
 *   orders' lines are added once, as their own row, and never spread over orders, channels or vendors.
 */
export function refundSummary(index, lines, { notPerOrder = null } = {}) {
  const orders = [...index.values()];
  const refunded = orders.filter(o => o.status === 'full' || o.status === 'partial');
  const byChannel = new Map(), byVendor = new Map();
  for (const o of refunded) {
    const ch = o.channel || 'Unknown';
    const b = byChannel.get(ch) || byChannel.set(ch, { key: ch, orders: 0, amount: 0 }).get(ch);
    b.orders++; b.amount += c(o.refund);
  }
  const refundedSet = new Set(refunded.map(o => o.orderNum));
  const perOrderVendorC = new Map();
  for (const l of lines) {
    if (!refundedSet.has(l.orderNum) || !(c(l.refundAllocated) > 0)) continue;
    const v = l.isRoute ? 'Route (pass-through)' : (l.vendor || l.store || 'Unknown');
    const b = byVendor.get(v) || byVendor.set(v, { key: v, orders: new Set(), amount: 0 }).get(v);
    b.orders.add(l.orderNum); b.amount += c(l.refundAllocated);
    perOrderVendorC.set(l.orderNum, (perOrderVendorC.get(l.orderNum) || 0) + c(l.refundAllocated));
  }
  // The part of an order's refund beyond its line shares (shipping, other) has no vendor.
  let beyond = 0, beyondOrders = 0;
  for (const o of refunded) { const r = c(o.refund) - (perOrderVendorC.get(o.orderNum) || 0); if (r > 0) { beyond += r; beyondOrders++; } }
  const NA = 'Not attributed to a vendor (shipping, other)';
  if (beyond > 0) byVendor.set(NA, { key: NA, orders: beyondOrders, amount: beyond });
  const sum = (arr, f) => arr.reduce((s, o) => s + c(o[f]), 0);
  const perOrder = sum(refunded, 'refund');
  const extra = notPerOrder ? c(notPerOrder.notPerOrder) : 0;
  const NO = 'Not allocated to an order (shipping, other)';
  if (extra > 0) { byChannel.set(NO, { key: NO, orders: null, amount: extra }); byVendor.set(NO, { key: NO, orders: null, amount: extra }); }
  const total = perOrder + extra;
  const fin = m => [...m.values()].map(b => ({ key: b.key, orders: b.orders instanceof Set ? b.orders.size : b.orders, amount: d$(b.amount),
    share: total ? Math.round(b.amount / total * 1000) / 10 : null })).sort((a, b) => b.amount - a.amount || (a.key < b.key ? -1 : 1));
  return {
    orders: orders.length, refundedOrders: refunded.length,
    fullRefunds: refunded.filter(o => o.status === 'full').length, partialRefunds: refunded.filter(o => o.status === 'partial').length,
    unknown: orders.filter(o => o.status === 'unknown').length, withoutRefunds: orders.filter(o => o.status === 'none').length,
    // CSV: per-order amounts are each order's complete refund. Automatic: allocated line shares, plus the
    // weeks' refunds beyond those lines; boundary weeks' amounts are excluded and listed (complete = false).
    basis: notPerOrder ? 'allocated' : 'order', allocatedRefunded: d$(perOrder), notAllocatedToOrders: d$(extra),
    boundaryNotAssigned: notPerOrder ? notPerOrder.boundary : [], complete: notPerOrder ? notPerOrder.complete : true,
    totalRefunded: d$(total), refundedPct: orders.length ? Math.round(refunded.length / orders.length * 1000) / 10 : null,
    netRevenueOfRefundedOrders: d$(sum(refunded, 'netRevenue')),
    retainedProductCost: d$(sum(refunded, 'knownCogs')), retainedShippingCost: d$(sum(refunded, 'shipPaid')),
    gpOfRefundedOrders: d$(sum(refunded, 'gp')),
    missingCostLinesOnRefunded: refunded.reduce((s, o) => s + o.missingCostLines, 0),
    byChannel: fin(byChannel), byVendor: fin(byVendor),
    hasDates: refunded.some(o => o.refundDate), hasReasons: refunded.some(o => o.refundReason),
  };
}
