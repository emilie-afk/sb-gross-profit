/**
 * Shipping Scenarios models (js/shippingScenarios.js): one order set and one cost coverage per comparison,
 * unknown costs never $0, mixed-vendor orders never modelled as losing their whole shipping charge.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { orderFacts, thresholdImpact, itemCountImpact, plantCostReduction, applyToReport, baselineBridge, isMcgLine } from '../js/shippingScenarios.js';

const SB = 'Succulents Box (17381)';
// First line of an order carries the order's shipping (as the calculator and saved reports do).
const L = (orderNum, o = {}) => ({ orderNum, store: SB, vendor: 'Succulents Box', sku: 'S2KY1048', product: 'Echeveria', qty: 1,
  lineRevenue: 10, lineCogs: 4, lineGp: 6, lineNetGp: 6, shipCollected: null, shipPaid: null, isFreeShip: '', ...o });
const first = (orderNum, ship, paid, o = {}) => L(orderNum, { shipCollected: ship, shipPaid: paid, ...o });

const lines = [
  // #1 MCG-only, $75 MCG, pays $8.99, cost $7.50, all costs known.
  first('#1', 8.99, 7.5, { lineRevenue: 45, lineNetGp: 20 + 1.49 }), L('#1', { lineRevenue: 30, lineNetGp: 12 }),
  // #2 MCG-only, $80, pays $8.99, one product cost unknown (the reported case: GP unknown).
  first('#2', 8.99, 9.1, { lineRevenue: 50, lineNetGp: 18 }), L('#2', { lineRevenue: 30, lineCogs: null, lineGp: null, lineNetGp: null }),
  // #3 MCG-only, $70, pays $8.99, shipping cost unknown.
  first('#3', 8.99, null, { lineRevenue: 70, lineNetGp: 30 }),
  // #4 mixed vendor: MCG $72 + a Live to Give item; one order-level charge of $14.98.
  first('#4', 14.98, 12, { lineRevenue: 72, lineNetGp: 25 }), L('#4', { vendor: 'Live to Give', sku: 'LTG-1', lineRevenue: 20, lineNetGp: 5 }),
  // #5 already free shipping (≥ $89).
  first('#5', 0, 8, { lineRevenue: 95, isFreeShip: 'YES', lineNetGp: 40 }),
  // #6 MCG-only, $60: below the new threshold.
  first('#6', 8.99, 7, { lineRevenue: 60, lineNetGp: 22 }),
  // #7 a gift card alongside MCG does not make the order mixed.
  first('#7', 8.99, 7, { lineRevenue: 70, lineNetGp: 28 }), L('#7', { vendor: 'Succulents Box', sku: 'GC25', costSource: 'Gift Card (no COGS)', lineRevenue: 25, lineNetGp: 25 }),
];

test('order facts: MCG subtotal, mixed vendors, shipping cost known or not, GP complete or not', () => {
  const f = orderFacts(lines);
  assert.equal(f.get('#1').mcgSubtotal, 75); assert.equal(f.get('#1').gp, 33.49); assert.equal(f.get('#1').gpComplete, true);
  assert.equal(f.get('#2').gp, null, 'a product cost is unknown');
  assert.equal(f.get('#3').gp, null, 'the shipping cost is unknown'); assert.equal(f.get('#3').shipPaidKnown, false);
  assert.equal(f.get('#4').mixed, true); assert.equal(f.get('#4').mcgSubtotal, 72);
  assert.equal(f.get('#7').mixed, false, 'gift cards do not ship');
  assert.equal(isMcgLine({ store: SB, vendor: 'HP Dropship', sku: 'HP-1' }), false);
});

test('threshold $89 → $69: full revenue impact and calculable profit impact reconcile; mixed orders apart', () => {
  const r = thresholdImpact(orderFacts(lines), 89, 69);
  assert.deepEqual(r.rows.map(o => o.orderNum).sort(), ['#1', '#2', '#3', '#7']);
  assert.equal(r.revenueLost, 35.96, 'every MCG-only affected order loses its charge');
  // Shipping cost unchanged: profit change = −revenue lost, calculable for every affected order (no order omitted).
  assert.deepEqual([r.profit.orders, r.profit.delta, r.profit.notCalculable], [4, -35.96, 0]);
  // GP before/after: only orders with complete GP, the same orders on both sides.
  assert.deepEqual([r.gpTable.orders, r.gpTable.excluded], [2, 2]);
  assert.equal(r.gpTable.after, r2(r.gpTable.before - 8.99 * 2));
  // The mixed-vendor order is not modelled as losing $14.98; it is reported separately.
  assert.deepEqual(r.mixed, { orders: 1, shipCollected: 14.98 });
  assert.throws(() => thresholdImpact(orderFacts(lines), 69, 89));
});

test('item count free shipping: unknown costs never $0; summary and table use the same orders', () => {
  const f = orderFacts(lines);
  const r = itemCountImpact(f, { 1: 5, 2: 6 });
  const byNum = Object.fromEntries(r.rows.map(o => [o.orderNum, o]));
  // #1: −8.99 + 7.50 − 6 = −7.49.  #2: −8.99 + 9.10 − 6 = −5.89 (product cost unknown does not matter to the change).
  assert.equal(byNum['#1'].profitDelta, -7.49); assert.equal(byNum['#2'].profitDelta, -5.89);
  // #3: shipping cost unknown → not calculable, never treated as $0 cost (which would show a gain).
  assert.equal(byNum['#3'].profitDelta, null);
  assert.equal(r.profit.notCalculable, 1); assert.equal(r.profit.notCalculableRevenueLost, 8.99);
  // The GP table uses only orders with complete GP, the same orders on both sides.
  const complete = r.rows.filter(o => o.gp !== null && o.profitDelta !== null);
  assert.equal(r.gpTable.orders, complete.length);
  assert.equal(r.gpTable.after, r2(r.gpTable.before + complete.reduce((s, o) => s + o.profitDelta, 0)));
  // Direction agrees: the summary's profit change and the table's change have the same sign here.
  assert.ok(r.profit.delta < 0 && r.gpTable.after < r.gpTable.before);
  // An order with an unknown product cost never gets a projected GP.
  assert.equal(r.rows.find(o => o.orderNum === '#2').gp, null);
  assert.deepEqual(r.mixed, { orders: 1, shipCollected: 14.98 }, '#4 (one MCG item + another vendor) is reported apart, not modelled');
  assert.ok(!r.rows.some(o => o.orderNum === '#5'), 'already free shipping: not affected');
});

test('plant cost reduction counts individual plants only; without the pack table nothing is projected', () => {
  const pack = { 'S2PK1001-10': 18, 'S3MY3003': 2 };
  const ls = [L('#1', { sku: 'S2KY1048', qty: 3 }), L('#1', { sku: 'S2PK1001-10', qty: 1 }), L('#2', { sku: 'S3MY3003', qty: 4 }),
              L('#3', { store: 'Live to Give', sku: 'S2KY1048', qty: 5 })];
  assert.deepEqual(plantCostReduction(ls, 0.5, pack), { available: true, plants: 3, savings: 1.5, excludedUnits: 5 });
  assert.equal(plantCostReduction(ls, 0.5, null).available, false);
});

test('report baseline and bridge: new GP = report GP + change; components plus remainder add up', () => {
  const a = applyToReport({ gp: 4134.98, revenue: 10909.75 }, -35.96, 35.96);
  assert.deepEqual(a.after, { gp: 4099.02, revenue: 10873.79, margin: 37.7 });
  const b = baselineBridge(4134.98, 3580.44, [{ label: 'Revenue of lines without a cost', amount: 412.5 }, { label: 'x', amount: 0 }]);
  assert.equal(b.components.length, 1);
  assert.equal(r2(b.modelGp + b.components[0].amount + b.other), 4134.98);
});

const r2 = x => Math.round(x * 100) / 100;
