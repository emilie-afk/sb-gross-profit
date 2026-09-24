/**
 * Route in the scenario calculator (Revision 4 A45–A47, A49; Revision 5 item 8).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate } from '../shared/calculator.js';
import { summarizeScenario, allocateOrderShipping, isPassThrough } from '../shared/scenario.js';
import { row } from './fixtures.mjs';

const COSTS = { 'MG-ALOE': 4.5, 'MG-JADE': 6 };
const lines = () => calculate([
  row({ Name: '#1', Subtotal: '30.98', Shipping: '5', Total: '35.98', 'Lineitem sku': 'MG-ALOE', 'Lineitem price': '10', 'Lineitem quantity': '2', Vendor: 'Succulents Box' }),
  row({ Name: '#1', Subtotal: '', Shipping: '', Total: '', 'Lineitem sku': 'ROUTEINS', 'Lineitem name': 'Shipping Protection by Route - 0.98', 'Lineitem price': '0.98', Vendor: 'Route' }),
  row({ Name: '#1', Subtotal: '', Shipping: '', Total: '', 'Lineitem sku': 'MG-JADE', 'Lineitem price': '10', Vendor: 'Succulents Box' }),
  row({ Name: '#2', Subtotal: '0.98', Shipping: '4', Total: '4.98', 'Lineitem sku': 'ROUTEINS', 'Lineitem name': 'Shipping Protection by Route - 0.98', 'Lineitem price': '0.98', Vendor: 'Route' }),
  row({ Name: '#2', Subtotal: '', Shipping: '', Total: '', 'Lineitem sku': 'MG-JADE', 'Lineitem price': '0', Vendor: 'Succulents Box' }),
], new Map([['1', 6], ['2', 4]]), {}, {}, {}, COSTS, {}, {}, null, {}, null, null);

const run = (a = {}) => summarizeScenario(lines(), { sitewideDiscount: 0.2, adRate: 0.1, targetMargin: 0.1, monthlyLabor: 3000,
  dateFrom: '2026-09-01', dateTo: '2026-09-30', ...a });

test('A45: a sitewide discount leaves Route revenue unchanged', () => {
  const r = run();
  for (const l of r.lines.filter(isPassThrough)) {
    assert.equal(l.discountEligible, false);
    assert.equal(l.scenarioRevenue, l.currentRevenue);
  }
});

test('A46: the advertising basis excludes Route', () => {
  const r = run();
  assert.equal(r.scenario.scenarioRevenue, 24);             // (20 + 10) × 0.8, Route excluded
  assert.equal(r.scenario.adExpense, 2.4);
  assert.ok(r.lines.filter(isPassThrough).every(l => l.adExpense === 0));
});

test('A47: Route takes no labor and no shipping allocation, and totals still reconcile', () => {
  const r = run();
  for (const l of r.lines.filter(isPassThrough)) {
    assert.deepEqual([l.laborExpense, l.allocShipCollected, l.allocShipExpense], [0, 0, 0]);
  }
  assert.ok(r.reconciliation.ok, JSON.stringify(r.reconciliation.checks.filter(c => !c.ok)));
  // Order #2's only other line has zero revenue: it still carries the order's shipping, Route does not.
  const jade2 = r.lines.find(l => l.orderNum === '#2' && l.sku === 'MG-JADE');
  assert.deepEqual([jade2.allocShipCollected, jade2.allocShipExpense], [4, 4]);
});

test('A49: Route has no reverse-cost result and is absent from vendor and SKU rows', () => {
  const r = run();
  for (const l of r.lines.filter(isPassThrough)) {
    assert.deepEqual([l.maxLineCogs, l.maxUnitCost, l.viable], [null, null, null]);
  }
  assert.ok(!r.byVendor.some(v => /route/i.test(v.vendor)));
  assert.ok(!r.bySku.some(s => /ROUTEINS/i.test(s.sku)));
  assert.ok(!r.missingCostLines.some(m => /ROUTEINS/i.test(m.sku)));
});

test('Route is reported as pass-through with a zero net', () => {
  const r = run();
  assert.deepEqual(r.passThrough, { routeCollected: 1.96, routeRemitted: 1.96, routeNet: 0, lines: 2 });
});

test('allocateOrderShipping gives Route nothing when other lines carry revenue', () => {
  const out = allocateOrderShipping([
    { orderNum: '#9', isRoute: true, scenarioRevenue: 0.98, shipCollected: 5, shipPaid: 4 },
    { orderNum: '#9', scenarioRevenue: 10, shipCollected: null, shipPaid: null },
  ]);
  assert.deepEqual(out.map(l => [l.allocShipCollected, l.allocShipExpense]), [[0, 0], [5, 4]]);
});
