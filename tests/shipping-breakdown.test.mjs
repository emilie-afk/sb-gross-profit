/**
 * Shipping screen: "Where the shipping net comes from" and "Shipping by vendor" (js/shippingBreakdown.js).
 * Every order lands in exactly one cause row (plus the pass-through row for its HPD / LR share)
 * and one vendor row, and both tables add up to the screen's net shipping. Synthetic orders in the calculator's
 * line shape (CSV uploads) and through storedLines (stored reports).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { shippingBreakdown, shippingOrders, breakdownCsv } from '../js/shippingBreakdown.js';
import { storedLines } from '../js/storedReport.js';
import { APS, HPD, HPW, LR, L2G, vendorName } from '../shared/vendors.js';

const MCG = 'Succulents Box (17381)';
let n = 0;
/** One order: `ship` on the first line (collected, paid, ss, hp, lr, note, status), `items` [{ store, revenue, ...flags }]. */
function order({ date = '2026-10-10', source = 'web', cat = 'Pure 17381', ship, items }) {
  const name = `#T${++n}`;
  return items.map((it, i) => ({
    orderNum: name, date, source, orderCat: i === 0 ? cat : null, store: it.store, sku: it.sku || `SKU${i}`, qty: 1,
    lineRevenue: it.revenue ?? 10, refundAllocated: it.refund ?? 0,
    isRoute: !!it.isRoute, isGiftCard: false, isDigital: !!it.isDigital, isSubRenewal: !!it.isSubRenewal, isInfluencerSample: !!it.isInfluencerSample,
    shipCollected: i === 0 ? ship.collected : null, shipPaid: i === 0 ? (ship.paid === undefined ? ship.ss ?? 0 : ship.paid) : null,
    shipPaidSS: i === 0 ? ship.ss ?? 0 : null, shipPaidHP: i === 0 ? ship.hp ?? 0 : null, shipPaidLR: i === 0 ? ship.lr ?? 0 : null,
    shipNote: i === 0 ? ship.note || null : null, shippingExpenseStatus: i === 0 ? ship.status : undefined,
  }));
}
const byKey = rows => Object.fromEntries(rows.map(r => [r.key, r]));
const sum = rows => Math.round(rows.reduce((s, r) => s + r.net, 0) * 100) / 100;

test('each order lands in its cause; both tables add up to the net shipping', () => {
  const lines = [
    ...order({ source: '294517', ship: { collected: 0, ss: 6.5 }, items: [{ store: MCG, revenue: 0, isSubRenewal: true }] }),
    ...order({ ship: { collected: 0, ss: 14 }, items: [{ store: MCG, revenue: 60 }, { store: MCG, revenue: 39 }] }),        // $99 of MCG items
    ...order({ ship: { collected: 0, ss: 9 }, items: [{ store: MCG, revenue: 95, refund: 10 }] }),                        // $95 before refunds
    ...order({ ship: { collected: 0, ss: 5 }, items: [{ store: MCG, revenue: 20 }] }),                                    // web, under $89
    ...order({ source: 'tiktok', ship: { collected: 0, ss: 7 }, items: [{ store: MCG, revenue: 20 }] }),
    ...order({ source: 'shopify_draft_order', ship: { collected: 0, ss: 8 }, items: [{ store: MCG, revenue: 20 }] }),
    ...order({ ship: { collected: 0, ss: 4 }, items: [{ store: MCG, revenue: 0, isInfluencerSample: true }] }),
    ...order({ date: '2026-08-10', cat: 'Pure Free Ship', ship: { collected: 0, ss: 6 }, items: [{ store: APS, revenue: 30 }] }),  // before Aug 14
    ...order({ date: '2026-08-20', cat: 'Pure Free Ship', ship: { collected: 0, ss: 6 }, items: [{ store: APS, revenue: 30 }] }),  // after: other
    ...order({ ship: { collected: 5, ss: 8 }, items: [{ store: MCG, revenue: 30 }] }),
    ...order({ ship: { collected: 9, ss: 7.25 }, items: [{ store: MCG, revenue: 30 }] }),
    ...order({ ship: { collected: 0, paid: null, ss: 0, status: 'complete' }, items: [{ store: MCG, revenue: 5, isDigital: true }] }),
    ...order({ ship: { collected: 6, paid: null, ss: 0, status: 'missing_shipstation_rate' }, items: [{ store: MCG, revenue: 30 }] }),
  ];
  const b = shippingBreakdown(lines);
  const c = byKey(b.causes);
  assert.deepEqual([c.sub_renewal.orders, c.sub_renewal.net], [1, -6.5]);
  assert.deepEqual([c.free_shipping_mcg.orders, c.free_shipping_mcg.net], [2, -23], 'MCG items of $89 or more (before refunds)');
  assert.deepEqual([c.zero_other.orders, c.zero_other.net], [2, -11], 'under $89 on the web; APS after its paid-shipping date');
  assert.deepEqual([c.zero_marketplace.net, c.zero_draft.net, c.zero_influencer.net], [-7, -8, -4]);
  assert.deepEqual([c.vendor_free_shipping.orders, c.vendor_free_shipping.net], [1, -6]);
  assert.deepEqual([c.charged_below.collected, c.charged_below.paid, c.charged_below.net], [5, 8, -3]);
  assert.deepEqual([c.charged_at_or_above.net], [1.75]);
  assert.deepEqual([c.no_shipment.orders, c.no_shipment.net], [1, 0]);
  assert.deepEqual([c.label_missing.orders, c.label_missing.collected, c.label_missing.paid], [1, 6, 0]);
  assert.equal(b.total.orders, 13);
  assert.equal(b.total.net, sum(b.causes));
  assert.equal(b.total.net, sum(b.vendors));
  assert.equal(b.total.net, Math.round((20 - 80.75) * 100) / 100, 'collected $20, paid $80.75');
});

test('HPD and LR shipping is pass-through ($0, not measured); a mixed order is split into its parts', () => {
  const lines = [
    ...order({ cat: 'Pure HP Dropship', ship: { collected: 12, paid: 12, hp: 12, note: 'HPD pass-through (Shopify shipping)' }, items: [{ store: HPD }] }),
    ...order({ cat: 'Pure HP Dropship', ship: { collected: 12, paid: 9, hp: 9, note: 'HPD actual (H1)' }, items: [{ store: HPW }] }),
    ...order({ cat: 'Pure HP Dropship', ship: { collected: 0, paid: 0, hp: 0, note: 'HPD pass-through (Shopify shipping)' }, items: [{ store: HPD }] }),
    // Mixed: ShipStation $8 for the MCG shipment, HPD gets the rest of the $15 paid ($7) as pass-through.
    ...order({ cat: 'Mixed (17381 + HP Dropship)', ship: { collected: 15, paid: 15, ss: 8, hp: 7, note: 'Mixed HPD shipping (SS $8.00 + HPD pass-through $7.00)' }, items: [{ store: MCG }, { store: HPD }] }),
    // Mixed where the customer paid less than the ShipStation label: HPD's pass-through share is $0.
    ...order({ cat: 'Mixed (17381 + HP Dropship)', ship: { collected: 5, paid: 8, ss: 8, hp: 0, note: 'Mixed HPD shipping (SS $8.00 + HPD pass-through $0.00)' }, items: [{ store: MCG }, { store: HPD }] }),
    ...order({ cat: 'Other', ship: { collected: 9, paid: 9, ss: 0, lr: 9, note: 'LR pass-through (Shopify Collective)' }, items: [{ store: LR }] }),
  ];
  const b = shippingBreakdown(lines);
  const c = byKey(b.causes), v = byKey(b.vendors);
  assert.deepEqual([c.pass_through.orders, c.pass_through.collected, c.pass_through.paid, c.pass_through.net], [4, 28, 28, 0]);
  assert.deepEqual([v[`pass:${HPD}`].orders, v[`pass:${HPD}`].collected, v[`pass:${HPD}`].measured], [3, 19, false], 'pure + zero-charged pure + mixed share');
  assert.deepEqual([v[`pass:${LR}`].orders, v[`pass:${LR}`].net], [1, 0]);
  assert.deepEqual([v[HPD].orders, v[HPD].collected, v[HPD].paid, v[HPD].net], [1, 12, 9, 3], 'HPD actual is measured');
  assert.deepEqual([v[MCG].orders, v[MCG].collected, v[MCG].paid, v[MCG].net], [2, 13, 16, -3], 'the ShipStation part of both mixed orders');
  assert.deepEqual([c.charged_at_or_above.orders, c.charged_below.orders], [2, 1]);
  assert.equal(b.total.net, 0, 'HPD actual +$3, the second mixed order −$3');
  assert.equal(sum(b.vendors), 0);
  assert.equal(sum(b.causes), 0);
  assert.equal(v[`pass:${HPD}`].label, `${vendorName(HPD)} (pass-through, not measured)`);
});

test('several shipping vendors in one order: one "Mixed, not split" row per vendor set; Route and digital lines are not vendors', () => {
  const lines = [
    ...order({ cat: 'Mixed (17381 + Free Ship)', ship: { collected: 12, ss: 15 }, items: [{ store: MCG }, { store: APS }, { store: 'Route', isRoute: true }] }),
    ...order({ cat: 'Mixed (17381 + Free Ship)', ship: { collected: 10, ss: 9 }, items: [{ store: APS }, { store: MCG }] }),
    ...order({ cat: 'Pure Free Ship', ship: { collected: 8, ss: 6 }, items: [{ store: L2G }, { store: MCG, isDigital: true }] }),
  ];
  const v = byKey(shippingBreakdown(lines).vendors);
  const mixed = v[`mixed:${[APS, MCG].sort().join('+')}`];
  assert.deepEqual([mixed.orders, mixed.collected, mixed.paid, mixed.net, mixed.vendor], [2, 22, 24, -2, null]);
  assert.match(mixed.label, /^Mixed, not split: /);
  assert.deepEqual([v[L2G].orders, v[L2G].net, v[L2G].avgPaid], [1, 2, 6], 'a digital MCG item does not make the order mixed');
});

test('stored reports: storedLines rows give the same records (no-shipment orders are not "label missing")', () => {
  const orders = [
    { order_name: '#S1', business_date: '2026-10-02', channel: '294517', order_cat: 'Pure 17381', ship_collected: 0, ship_paid: 6.46, ship_paid_ss: 6.46, ship_paid_hp: 0,
      shipping_expense_status: 'complete', shipping_expense_source: 'shipping_cost_report', requires_ss_rate: 1 },
    { order_name: '#S2', business_date: '2026-10-02', channel: 'web', order_cat: 'Pure 17381', ship_collected: 0, ship_paid: null, ship_paid_ss: 0, ship_paid_hp: 0,
      shipping_expense_status: 'complete', shipping_expense_source: 'no_shipment_required', requires_ss_rate: 0 },
    { order_name: '#S3', business_date: '2026-10-03', channel: 'web', order_cat: 'Pure 17381', ship_collected: 7, ship_paid: null, ship_paid_ss: 0, ship_paid_hp: 0,
      shipping_expense_status: 'missing_shipstation_rate', shipping_expense_source: 'missing', requires_ss_rate: 1 },
  ];
  const flags = o => JSON.stringify({ isProductLine: true, ...o });
  const lines = [
    { order_name: '#S1', line_index: 0, store: MCG, sku: 'SUB3', product: 'Sub', qty: 1, contract_revenue: 0, line_cogs: 9, flags: flags({ isSubRenewal: true }) },
    { order_name: '#S2', line_index: 0, store: MCG, sku: 'PRINT', product: 'Printable', qty: 1, contract_revenue: 0, line_cogs: 0, flags: flags({ isDigital: true }) },
    { order_name: '#S3', line_index: 0, store: MCG, sku: 'MG-1', product: 'Plant', qty: 1, contract_revenue: 25, line_cogs: 5, flags: flags({}) },
  ];
  const recs = Object.fromEntries(shippingOrders(storedLines(orders, lines)).map(r => [r.name, r]));
  assert.deepEqual([recs['#S1'].subRenewal, recs['#S1'].labelMissing], [true, false]);
  assert.deepEqual([recs['#S2'].labelMissing, recs['#S2'].vendors], [false, []]);
  assert.equal(recs['#S3'].labelMissing, true);
  const c = byKey(shippingBreakdown(storedLines(orders, lines)).causes);
  assert.deepEqual([c.sub_renewal.net, c.no_shipment.orders, c.label_missing.collected], [-6.46, 1, 7]);
});

test('CSV export of both tables', () => {
  const b = shippingBreakdown(order({ ship: { collected: 5, ss: 8 }, items: [{ store: MCG }] }));
  const causes = breakdownCsv(b.causes, 'causes').trim().split('\n');
  assert.equal(causes[0], 'Where the shipping net comes from,Orders,Collected,Paid,Net');
  assert.equal(causes[1], '"Customer paid shipping, less than the label",1,5.00,8.00,-3.00');
  const vendors = breakdownCsv(b.vendors, 'vendors').trim().split('\n');
  assert.equal(vendors[0], 'Vendor,Orders,Collected,Paid,Net,Average paid per order,Measured');
  assert.equal(vendors[1], `${vendorName(MCG)},1,5.00,8.00,-3.00,8.00,yes`);
});
