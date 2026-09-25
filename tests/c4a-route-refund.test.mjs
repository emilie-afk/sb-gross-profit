/**
 * C4a — Route refund allocation. Synthetic fixtures only.
 *
 * A general (order-level) Shopify refund is never spread onto the Route
 * Shipping Protection line. A Route refund is recognised only when Shopify's
 * refund lines explicitly name the Route line; Route stays a zero-contribution,
 * customer-funded pass-through either way.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate, summarize, isRouteLine } from '../shared/calculator.js';
import { summarizeScenario, isPassThrough } from '../shared/scenario.js';
import { buildSnapshot } from '../shared/snapshot.js';
import { csvRowsToNormalizedOrders, explicitRouteRefunds } from '../shared/adapters/legacy.js';
import { normalizeShopifyOrders } from '../shared/adapters/shopifyGraphql.js';
import { csvOrder, gqlOrder, FIXTURE_CATALOG } from './fixtures-normalized.mjs';

const ROUTE = { sku: 'ROUTEINS', name: 'Shipping Protection by Route - 0.98', vendor: 'Route', price: 0.98 };
const COSTS = { 'MG-ALOE': 4.5, 'MG-JADE': 6 };
// Products $20 + $10, Route $0.98, shipping $5 → Total $35.98
const order = (o = {}) => csvOrder({ name: '#1', subtotal: 30.98, shipping: 5, total: 35.98, lines: [
  { sku: 'MG-ALOE', price: 10, qty: 2, vendor: 'Succulents Box' }, ROUTE,
  { sku: 'MG-JADE', price: 10, vendor: 'Succulents Box' }], ...o });
const calc = (rows, options = {}) => calculate(rows, new Map([['1', 6]]), {}, {}, {}, COSTS, {}, {}, null, {}, null, null, options);
const bySku = (lines, sku) => lines.find(l => l.sku === sku);
const snap = orders => buildSnapshot({ weekStart: '2026-09-14', orders, catalog: FIXTURE_CATALOG });
const sline = (s, sku) => s.lines.find(l => l.sku === sku);

test('C4a: a general refund is prorated over product lines only — Route keeps its full amount', () => {
  const lines = calc(order({ refunded: 6 }));
  const route = bySku(lines, 'ROUTEINS');
  assert.equal(route.refundAllocated, 0);
  assert.equal(route.lineRevenue, 0.98);
  assert.equal(route.lineCogs, 0.98);
  assert.equal(route.lineGp, 0);
  // $6 over $20 / $10 of product revenue (before C4a Route took $0.19 of it)
  assert.deepEqual([bySku(lines, 'MG-ALOE').refundAllocated, bySku(lines, 'MG-JADE').refundAllocated], [4, 2]);
  assert.deepEqual([bySku(lines, 'MG-ALOE').lineRevenue, bySku(lines, 'MG-JADE').lineRevenue], [16, 8]);
  assert.equal(lines[0].refundBeyondProduct, 0);
  assert.equal(lines[0].routeRefund, undefined);
  const s = summarize(lines);
  assert.equal(s.totalRevenue, 29.98);                       // Total − Refunded, unchanged by allocation
  assert.equal(Math.round(s.productRevenue * 100) / 100, 24.98);
  assert.equal(s.totalGp, Math.round((29.98 - 15.98 - 6) * 100) / 100);
});

test('C4a: headline revenue, COGS and GP do not change — only the line split does', () => {
  const rows = order({ refunded: 6 });
  const s = summarize(calc(rows));
  // The refund moves between lines; order-level revenue, COGS and shipping are unchanged.
  assert.equal(s.totalCogs, 15.98);
  assert.equal(s.totalShipPaid, 6);
  assert.equal(s.totalGp, 8);
});

test('C4a: a refund larger than product revenue stays order-level, never on Route', () => {
  const lines = calc(order({ refunded: 35.98 }));
  assert.equal(bySku(lines, 'ROUTEINS').refundAllocated, 0);
  assert.equal(bySku(lines, 'ROUTEINS').lineRevenue, 0.98);
  assert.equal(bySku(lines, 'MG-ALOE').lineRevenue, 0);
  assert.equal(bySku(lines, 'MG-JADE').lineRevenue, 0);
  // $5 shipping + $0.98 not attributed by Shopify to any line
  assert.equal(lines[0].refundBeyondProduct, 5.98);
});

test('C4a: an explicit Shopify Route refund reduces Route collected and remitted together', () => {
  const lines = calc(order({ refunded: 6.98 }), { routeRefunds: new Map([['#1', 0.98]]) });
  const route = bySku(lines, 'ROUTEINS');
  assert.deepEqual([route.refundAllocated, route.lineRevenue, route.lineCogs, route.lineGp], [0.98, 0, 0, 0]);
  assert.equal(route.routeRefundSource, 'shopify_refund_line');
  assert.deepEqual([bySku(lines, 'MG-ALOE').refundAllocated, bySku(lines, 'MG-JADE').refundAllocated], [4, 2]);
  assert.equal(lines[0].routeRefund, 0.98);
  assert.equal(lines[0].refundBeyondProduct, 0);
  const s = summarize(lines);
  assert.equal(s.totalRevenue, 29);
  assert.equal(s.totalCogs, 15);                              // Route pass-through not remitted
  assert.equal(s.totalGp, 8);                                 // same GP as the $6 product-only refund
});

test('C4a: an explicit Route refund is capped at the Route amount and at the order refund', () => {
  const capped = calc(order({ refunded: 6.98 }), { routeRefunds: new Map([['#1', 5]]) });
  assert.equal(bySku(capped, 'ROUTEINS').refundAllocated, 0.98);
  assert.equal(bySku(capped, 'MG-ALOE').refundAllocated + bySku(capped, 'MG-JADE').refundAllocated, 6);
  const small = calc(order({ refunded: 0.5 }), { routeRefunds: new Map([['#1', 0.98]]) });
  assert.equal(bySku(small, 'ROUTEINS').refundAllocated, 0.5);
  assert.equal(bySku(small, 'MG-ALOE').refundAllocated, 0);
  assert.throws(() => calc(order({ refunded: 6 }), { routeRefunds: { '#1': 1 } }), /routeRefunds must be a Map/);
});

test('C4a: Route detection by SKU or Shopify product name', () => {
  assert.equal(isRouteLine('ROUTEINS'), true);
  assert.equal(isRouteLine('routeins-2', ''), true);
  assert.equal(isRouteLine('RT-OTHER', 'Shipping Protection by Route - 0.98'), true);
  assert.equal(isRouteLine('MG-ALOE', 'Aloe'), false);
  const lines = calc(csvOrder({ name: '#1', subtotal: 20.98, total: 20.98, refunded: 3, lines: [
    { sku: 'MG-ALOE', price: 20, vendor: 'Succulents Box' }, { sku: 'RT-OTHER', price: 0.98, name: ROUTE.name }] }));
  assert.equal(bySku(lines, 'RT-OTHER').refundAllocated, 0);
  assert.equal(bySku(lines, 'MG-ALOE').refundAllocated, 3);
});

test('C4a: historical CSV orders never yield an explicit Route refund', () => {
  const orders = csvRowsToNormalizedOrders(order({ refunded: 6.98 }));
  assert.equal(explicitRouteRefunds(orders).size, 0);
});

test('C4a: GraphQL refund lines naming the Route line are the only Route refund source', () => {
  const orders = normalizeShopifyOrders([gqlOrder({ name: '#13', subtotal: 10.98, total: 10.98, refunded: 3.98,
    lines: [{ sku: 'MG-ALOE', price: 10, vendor: 'Succulents Box' }, { sku: 'ROUTEINS', name: ROUTE.name, price: 0.98, vendor: 'Route' }],
    refunds: [{ amount: 3.98, lines: [{ lineIndex: 0, subtotal: 3 }, { lineIndex: 1, subtotal: 0.98 }] }] })]);
  assert.deepEqual([...explicitRouteRefunds(orders)], [['#13', 0.98]]);
});

test('C4a: engine and Worker contract agree on Route after a general CSV refund', () => {
  const s = snap(csvRowsToNormalizedOrders(csvOrder({ name: '#3', subtotal: 30.98, shipping: 5, total: 35.98, refunded: 6, lines: [
    { sku: 'MG-ALOE', price: 20, vendor: 'Succulents Box' }, { sku: 'MG-JADE', price: 10, vendor: 'Succulents Box' }, ROUTE] })));
  assert.equal(sline(s, 'ROUTEINS').routeCollected, 0.98);
  assert.equal(sline(s, 'ROUTEINS').refundAllocated, 0);
  assert.equal(s.totals.routeNet, 0);
  assert.ok(s.reconciliation.every(c => c.passed), JSON.stringify(s.reconciliation.filter(c => !c.passed)));
  assert.equal(s.revenueBridge.components.refundsBeyondProductRevenue, 0);
  assert.equal(s.revenueBridge.unexplainedResidual, 0);
});

test('C4a: an explicit GraphQL Route refund keeps every snapshot reconciliation passing', () => {
  const orders = normalizeShopifyOrders([gqlOrder({ name: '#14', subtotal: 20.98, total: 20.98, refunded: 4.98,
    lines: [{ sku: 'MG-ALOE', price: 20, vendor: 'Succulents Box' }, { sku: 'ROUTEINS', name: ROUTE.name, price: 0.98, vendor: 'Route' }],
    refunds: [{ amount: 4.98, lines: [{ lineIndex: 0, subtotal: 4 }, { lineIndex: 1, subtotal: 0.98 }] }] })]);
  const s = snap(orders);
  assert.deepEqual([sline(s, 'ROUTEINS').routeCollected, sline(s, 'ROUTEINS').routeRemitted], [0, 0]);
  assert.equal(s.totals.routeNet, 0);
  assert.ok(s.reconciliation.every(c => c.passed), JSON.stringify(s.reconciliation.filter(c => !c.passed)));
  assert.equal(s.revenueBridge.unexplainedResidual, 0);
});

test('C4a: the browser scenario keeps the full Route pass-through after a general refund', () => {
  const r = summarizeScenario(calc(order({ refunded: 6 })), { sitewideDiscount: 0, adRate: 0.1, targetMargin: 0.1,
    monthlyLabor: 0, dateFrom: '2026-09-01', dateTo: '2026-09-30' });
  assert.deepEqual([r.passThrough.routeCollected, r.passThrough.routeRemitted, r.passThrough.routeNet], [0.98, 0.98, 0]);
  assert.ok(r.lines.filter(isPassThrough).every(l => l.currentRevenue === 0.98));
  assert.equal(r.current.currentRevenue, 24);                // $30 product − $6 refund, Route excluded
  assert.ok(!r.byVendor.some(v => /route/i.test(v.vendor)));
});
