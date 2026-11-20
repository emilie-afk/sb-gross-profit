/**
 * shippingBreakdown.js — where the shipping net comes from, and shipping by vendor (Shipping screen)
 * =================================================================================================
 * Pure, dashboard only. Reads the line items the Shipping screen already has (calculator shape: CSV uploads, and
 * stored reports through storedReport.storedLines), so weekly, monthly, custom-date and CSV reports agree. It
 * never changes an amount: every order's collected and paid shipping is only sorted into rows, and each table's
 * total equals the screen's net shipping.
 *
 * Each order is split into at most two parts:
 *   pass-through  the HPD share (unless HPD reported its actual cost) and the LR share: the
 *                 expense is set equal to what the customer paid for it, so it nets $0 by rule and is not measured;
 *   measured      the rest: what the customer paid for it, and the label cost (ShipStation, or HPD actual).
 *
 * Causes (the measured part, first match):
 *   label_missing        the order needs a ShipStation label cost that is not in yet
 *   no_shipment          nothing charged and nothing paid (digital or no shipment)
 *   sub_renewal          $0 charged, a subscription renewal: shipping is inside the subscription price
 *   free_shipping_mcg    $0 charged, MCG (17381) items of at least the free-shipping threshold
 *   vendor_free_shipping $0 charged, a vendor's free shipping still in effect on the order date
 *   zero_draft / zero_influencer / zero_marketplace / zero_other   $0 charged for another reason
 *   charged_below        the customer paid shipping, less than the label cost
 *   charged_at_or_above  the customer paid shipping, at least the label cost
 *
 * Vendors (who ships): the measured part goes to the one vendor (fulfilment store) of the order's shipped items;
 * an order whose measured part covers several vendors is a "Mixed, not split" row (one per vendor set), because
 * the label cost of each vendor's shipment is not known per vendor. The pass-through part goes to its own
 * vendor row (HPD, LR), marked as not measured.
 */
import { DEFAULT_POLICY_SETTINGS } from '../shared/shippingPolicy.js';
import { HP_STORES, LR, HPD, toCode, vendorName } from '../shared/vendors.js';

export const MCG_STORE = 'Succulents Box (17381)';
const MARKETPLACES = new Set(['amazon', 'walmart', 'ebay', 'etsy', 'tiktok', 'sellbrite']);
const cents = v => Math.round((Number(v) || 0) * 100);
const dollars = c => c / 100;

export const CAUSES = Object.freeze([
  { key: 'sub_renewal', label: 'Subscription renewals: shipping is inside the subscription price' },
  { key: 'free_shipping_mcg', label: 'Free shipping on MCG items over the threshold' },
  { key: 'vendor_free_shipping', label: 'Vendor free shipping (before the vendor’s paid-shipping date)' },
  { key: 'zero_marketplace', label: 'No shipping charged: marketplace orders' },
  { key: 'zero_draft', label: 'No shipping charged: draft orders' },
  { key: 'zero_influencer', label: 'No shipping charged: influencer samples' },
  { key: 'zero_other', label: 'No shipping charged: other orders' },
  { key: 'charged_below', label: 'Customer paid shipping, less than the label' },
  { key: 'charged_at_or_above', label: 'Customer paid shipping, at or above the label' },
  { key: 'no_shipment', label: 'No shipment (digital, nothing shipped)' },
  { key: 'label_missing', label: 'Label cost not in yet' },
  { key: 'pass_through', label: 'Pass-through: HPD and LR (not measured, $0 by rule)' },
]);
const CAUSE_LABEL = Object.fromEntries(CAUSES.map(c => [c.key, c.label]));

/** The fulfilment vendor of a shipped line (HPD's three Shopify vendors count as one), or null. */
function shippingVendor(li) {
  if (li.isRoute || li.isGiftCard || li.isDigital) return null;
  const s = li.store ? toCode(li.store) : '';
  if (!s || s === 'Shipping only') return null;
  return HP_STORES.includes(s) ? HPD : s;
}

/** Calculator-shape line items → one record per order (order-level amounts are on the order's first line). */
export function shippingOrders(lines) {
  const by = new Map();
  for (const li of lines || []) {
    let o = by.get(li.orderNum);
    if (!o) by.set(li.orderNum, o = { name: li.orderNum, date: li.date || '', first: null, lines: [] });
    if (!o.first && li.shipCollected !== null && li.shipCollected !== undefined) o.first = li;
    o.lines.push(li);
  }
  const out = [];
  for (const o of by.values()) {
    const f = o.first;
    if (!f) continue;                                       // no order-level shipping row: not on the Shipping screen
    const note = String(f.shipNote || '');
    const hp = cents(f.shipPaidHP), lr = cents(f.shipPaidLR);
    const vendors = [...new Set(o.lines.map(shippingVendor).filter(Boolean))];
    // HPD's shipping is pass-through unless HPD reported the actual cost; LR's always is.
    const hpRule = vendors.includes(HPD) && !/HPD actual/i.test(note);
    const hpPass = hpRule ? hp : 0;
    out.push({
      name: o.name, date: o.date, category: f.orderCat || 'Other',
      channel: String(f.source || '').trim().toLowerCase(),
      collected: cents(f.shipCollected),
      paid: f.shipPaid === null || f.shipPaid === undefined ? null : cents(f.shipPaid),
      // A label cost is "not in yet" only when the order needs one: stored reports say so (status); a CSV order with
      // no cost and shipped items needs one. "No shipment required" (status complete, no cost) is not missing.
      labelMissing: f.shippingExpenseStatus === 'missing_shipstation_rate'
        || ((f.shipPaid === null || f.shipPaid === undefined) && !f.shippingExpenseStatus && vendors.length > 0),
      hpPass, lrPass: lr, hpRule, lrRule: vendors.includes(LR) || lr > 0,
      subRenewal: o.lines.some(l => l.isSubRenewal),
      influencer: o.lines.some(l => l.isInfluencerSample),
      // Net merchandise of MCG items (before refunds), the free-shipping threshold's basis.
      mcgNet: o.lines.filter(l => shippingVendor(l) === MCG_STORE && !l.isSubRenewal)
        .reduce((s, l) => s + cents(l.lineRevenue) + cents(l.refundAllocated), 0),
      vendors,
    });
  }
  return out;
}

function causeOf(r, part, cfg) {
  if (r.labelMissing) return 'label_missing';
  if (part.collected === 0 && part.paid === 0) return 'no_shipment';
  if (part.collected === 0) {
    if (r.subRenewal) return 'sub_renewal';
    if (Number.isFinite(cfg.threshold) && r.mcgNet >= Math.round(cfg.threshold * 100)) return 'free_shipping_mcg';
    if (r.vendors.some(v => cfg.cutoffs[v] && r.date && r.date < cfg.cutoffs[v])) return 'vendor_free_shipping';
    if (r.channel === 'shopify_draft_order') return 'zero_draft';
    if (r.influencer) return 'zero_influencer';
    if (MARKETPLACES.has(r.channel)) return 'zero_marketplace';
    return 'zero_other';
  }
  return part.collected < part.paid ? 'charged_below' : 'charged_at_or_above';
}

const row = () => ({ orders: 0, collected: 0, paid: 0 });
const add = (m, key, part, extra = {}) => { const x = m.get(key) || m.set(key, { key, ...extra, ...row(), names: new Set() }).get(key); x.collected += part.collected; x.paid += part.paid; x.names.add(part.name); };
const finish = x => { const { names, ...rest } = x; return { ...rest, orders: names.size, collected: dollars(x.collected), paid: dollars(x.paid), net: dollars(x.collected - x.paid) }; };

/** Settings → { threshold, cutoffs } for causeOf. */
function configOf(settings = {}) {
  const s = { ...DEFAULT_POLICY_SETTINGS, ...settings };
  return { threshold: Number(s.mcg_free_shipping_threshold),
    cutoffs: Object.fromEntries(Object.entries(s.vendor_first_paid_shipping_dates || {}).map(([k, v]) => [toCode(k), v])) };
}
const passLabelOf = vendor => `${vendorName(vendor)} (pass-through, not measured)`;

/**
 * One order's shipping split into its parts (cents): pass-through parts ({ vendor, collected, paid }) and the measured
 * part ({ collected, paid, cause, vendorKey, vendor, label }) or null when the order has none (pass-through only).
 * The Shipping screen's tables and the order list are both built from this, so they always agree.
 */
function orderParts(r, cfg) {
  const paid = r.paid ?? 0;
  // Pass-through parts: their expense equals what the customer paid for them (never more than the order's).
  const pass = [];
  for (const [amount, vendor] of [[r.hpPass, HPD], [r.lrPass, LR]]) if (amount > 0) pass.push({ vendor, collected: amount, paid: amount });
  const passTotal = pass.reduce((t, p) => t + p.paid, 0);
  // Vendors whose labels make up the measured part: not the pass-through vendors.
  const shipped = r.vendors.filter(v => !(v === HPD && r.hpRule) && !(v === LR && r.lrRule));
  const passOnly = !shipped.length && (r.hpRule || r.lrRule);
  if (passOnly && !pass.length) pass.push({ vendor: r.hpRule ? HPD : LR, collected: 0, paid: 0 });   // nothing charged: $0 by rule too
  const m = { collected: r.collected - passTotal, paid: paid - passTotal };
  const present = r.labelMissing || m.collected !== 0 || m.paid !== 0 || (!passTotal && !passOnly);
  let measured = null;
  if (present) {
    const sorted = [...shipped].sort();
    measured = { ...m, cause: causeOf(r, m, cfg),
      vendorKey: shipped.length === 1 ? shipped[0] : shipped.length ? `mixed:${sorted.join('+')}` : 'none',
      vendor: shipped.length === 1 ? shipped[0] : null,
      label: shipped.length === 1 ? vendorName(shipped[0]) : shipped.length ? `Mixed, not split: ${sorted.map(vendorName).join(' + ')}` : 'No shipped items' };
  }
  return { pass, measured, paid };
}

/**
 * @param {object[]} lines     calculator-shape line items (the Shipping screen's)
 * @param {object} [settings]  { mcg_free_shipping_threshold, vendor_first_paid_shipping_dates } (shippingPolicy defaults)
 * @returns {{ causes: object[], vendors: object[], total: { orders, collected, paid, net } }} dollars; each table sums to total
 */
export function shippingBreakdown(lines, settings = {}) {
  const cfg = configOf(settings);
  const causes = new Map(), vendors = new Map();
  const total = { ...row(), names: new Set() };
  for (const r of shippingOrders(lines)) {
    const { pass, measured, paid } = orderParts(r, cfg);
    for (const p of pass) {
      const part = { name: r.name, collected: p.collected, paid: p.paid };
      add(causes, 'pass_through', part);
      add(vendors, `pass:${p.vendor}`, part, { vendor: p.vendor, label: passLabelOf(p.vendor), measured: false });
    }
    if (measured) {
      const part = { name: r.name, collected: measured.collected, paid: measured.paid };
      add(causes, measured.cause, part);
      add(vendors, measured.vendorKey, part, { vendor: measured.vendor, label: measured.label, measured: true, labelMissing: r.labelMissing });
    }
    total.collected += r.collected; total.paid += paid; total.names.add(r.name);
  }
  const passLabel = `Pass-through: ${vendorName(HPD)} and ${vendorName(LR)} (not measured, $0 by rule)`;   // names from the private legend
  const order = new Map(CAUSES.map((c, i) => [c.key, i]));
  const causeRows = [...causes.values()].map(finish).map(x => ({ ...x, label: x.key === 'pass_through' ? passLabel : CAUSE_LABEL[x.key] }))
    .sort((a, b) => order.get(a.key) - order.get(b.key));
  const vendorRows = [...vendors.values()].map(finish).map(x => ({ ...x, avgPaid: x.orders ? Math.round(x.paid / x.orders * 100) / 100 : 0 }))
    .sort((a, b) => (a.measured === b.measured ? b.paid - a.paid : a.measured ? -1 : 1));
  return { causes: causeRows, vendors: vendorRows, total: finish(total) };
}

/**
 * One row per order with its shipping (dollars), for the order list behind the Shipping screen's tables:
 *   { order, date, channel, category, collected, paid, net, measuredCollected, measuredPaid, measuredNet, passThrough,
 *     cause, causeLabel, vendorKey, vendorLabel, passVendors: [codes], labelMissing }
 * cause / vendorKey are the measured part's (the row it sits in in each table); an order with only pass-through
 * shipping has cause 'pass_through' and vendorKey 'pass:<code>'. Its pass-through vendors are in passVendors, so a
 * filter on a pass-through table row finds every order that has that pass-through part.
 */
export function shippingOrderRows(lines, settings = {}) {
  const cfg = configOf(settings);
  const passLabel = `Pass-through: ${vendorName(HPD)} and ${vendorName(LR)} (not measured, $0 by rule)`;
  return shippingOrders(lines).map(r => {
    const { pass, measured, paid } = orderParts(r, cfg);
    const passAmt = pass.reduce((t, p) => t + p.paid, 0);
    const first = pass[0]?.vendor;
    return {
      order: r.name, date: r.date, channel: r.channel, category: r.category,
      collected: dollars(r.collected), paid: dollars(paid), net: dollars(r.collected - paid),
      measuredCollected: measured ? dollars(measured.collected) : 0, measuredPaid: measured ? dollars(measured.paid) : 0,
      measuredNet: measured ? dollars(measured.collected - measured.paid) : 0, passThrough: dollars(passAmt),
      cause: measured ? measured.cause : 'pass_through', causeLabel: measured ? CAUSE_LABEL[measured.cause] : passLabel,
      vendorKey: measured ? measured.vendorKey : `pass:${first}`, vendorLabel: measured ? measured.label : passLabelOf(first),
      passVendors: pass.map(p => p.vendor), labelMissing: r.labelMissing,
    };
  });
}

/** Does an order row belong to a table row? kind 'causes' | 'vendors', key as in shippingBreakdown's rows. */
export function orderInRow(o, kind, key) {
  if (kind === 'causes') return key === 'pass_through' ? o.passVendors.length > 0 || o.cause === 'pass_through' : o.cause === key;
  if (String(key).startsWith('pass:')) return o.passVendors.includes(key.slice(5));
  return o.vendorKey === key;
}

/** CSV of order rows (the Shipping view). */
export function shippingOrdersCsv(rows) {
  const q = v => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const head = ['Order', 'Date', 'Channel', 'Shipping vendor', 'Where the shipping net comes from', 'Collected', 'Paid (label + pass-through)', 'Net',
                'Pass-through (not measured)', 'Label cost in'];
  const body = rows.map(o => [o.order, o.date, o.channel, o.vendorLabel, o.causeLabel, o.collected.toFixed(2), o.paid.toFixed(2), o.net.toFixed(2),
                              o.passThrough.toFixed(2), o.labelMissing ? 'no' : 'yes'].map(q).join(','));
  return [head.join(','), ...body].join('\n') + '\n';
}

/** CSV text for one of the two tables (rows as returned by shippingBreakdown). */
export function breakdownCsv(rows, kind) {
  const q = v => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const head = kind === 'vendors' ? ['Vendor', 'Orders', 'Collected', 'Paid', 'Net', 'Average paid per order', 'Measured']
    : ['Where the shipping net comes from', 'Orders', 'Collected', 'Paid', 'Net'];
  const body = rows.map(r => (kind === 'vendors'
    ? [r.label, r.orders, r.collected.toFixed(2), r.paid.toFixed(2), r.net.toFixed(2), r.avgPaid.toFixed(2), r.measured ? 'yes' : 'no (pass-through)']
    : [r.label, r.orders, r.collected.toFixed(2), r.paid.toFixed(2), r.net.toFixed(2)]).map(q).join(','));
  return [head.join(','), ...body].join('\n') + '\n';
}
