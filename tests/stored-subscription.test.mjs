/**
 * Subscription P&L on automatic reports: the per-delivery subscription fields rebuilt from stored rows equal the
 * CSV calculator's for the same orders. Synthetic fixtures only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate } from '../shared/calculator.js';
import { buildSnapshot } from '../shared/snapshot.js';
import { orderRow, lineRow } from '../shared/resultParts.js';
import { csvRowsToNormalizedOrders } from '../shared/adapters/legacy.js';
import { normalizeShipStationRows } from '../shared/adapters/shipstation.js';
import { storedLines, subMonthsOf, markSeveralSubscriptions } from '../js/storedReport.js';
import { csvOrder, ssCustom, FIXTURE_CATALOG } from './fixtures-normalized.mjs';

const ORDERS = [
  // 12 months prepaid: shipping for all months upfront
  csvOrder({ name: '#801', subtotal: 240, shipping: 83.88, total: 323.88, lines: [{ sku: 'SUB5-1-12', price: 240, vendor: 'Succulents Box' }] }),
  // a monthly clay-pot box with a regular item: shipping split by revenue share
  csvOrder({ name: '#802', subtotal: 50, shipping: 9, total: 59, lines: [
    { sku: 'SUB2-1-POT', price: 30, vendor: 'Succulents Box' }, { sku: 'MG-ALOE', price: 20, vendor: 'Succulents Box' }] }),
  // a renewal delivery: nothing charged
  csvOrder({ name: '#803', subtotal: 0, shipping: 0, total: 0, lines: [{ sku: 'GSUB3-1-6', price: 0, vendor: 'Succulents Box' }] }),
  // no label cost yet
  csvOrder({ name: '#804', subtotal: 25, shipping: 6.99, total: 31.99, lines: [{ sku: 'SUB1-1-1', price: 25, vendor: 'Succulents Box' }] }),
  // an order discount of nearly the whole merchandise: allocated to the lines on stored reports, never in the CSV
  // calculator's revenue share (line price less line discount), so the shipping split stays $30 : $20
  csvOrder({ name: '#805', subtotal: 0.01, shipping: 9, total: 9.01, discountAmount: 49.99, lines: [
    { sku: 'SUB2-1-1', price: 30, vendor: 'Succulents Box' }, { sku: 'MG-ALOE', price: 20, vendor: 'Succulents Box' }] }),
  // a line discount and a refund: the share uses the line price less its line discount, before the refund
  csvOrder({ name: '#806', subtotal: 45, shipping: 10, total: 55, refunded: 20, lines: [
    { sku: 'SUB3-1-1', price: 30, discount: 5, vendor: 'Succulents Box' }, { sku: 'MG-JADE', price: 20, vendor: 'Succulents Box' }] }),
  // the known rounding limit: a 12-month subscription first in a shared order ($10 shipping is stored as $0.83 a month)
  csvOrder({ name: '#807', subtotal: 400, shipping: 10, total: 410, lines: [
    { sku: 'SUB2-1-12', price: 300, vendor: 'Succulents Box' }, { sku: 'MG-JADE', price: 100, vendor: 'Succulents Box' }] }),
  // two subscriptions in one order: Shopify's export fills Shipping on the first row only, so the CSV calculator
  // gives the second subscription $0 of the order's shipping; the split is not known on either path
  csvOrder({ name: '#808', subtotal: 400, shipping: 10, total: 410, lines: [
    { sku: 'SUB1-1-12', price: 100, vendor: 'Succulents Box' }, { sku: 'SUB4-1-1', price: 300, vendor: 'Succulents Box' }] }),
].map((rows, i) => rows.map(r => ({ ...r, 'Created at': `2026-09-${String(15 + i).padStart(2, '0')} 10:00:00 -0700` })));
const LABELS = { '801': '7.40', '802': '8.10', '803': '6.25', '805': '8.40', '806': '7.10', '808': '9.20' };
const FIELDS = ['subMonths', 'subShipMo', 'expSubShipMo', 'subSSCostMo', 'subShipLoss', 'subShipUnavailable'];

test('subscription SKU months: the last number of 1–24; 1 for other SKUs', () => {
  assert.deepEqual(['SUB5-1-12', 'GSUB3-1-6', 'SUB2-1-POT', 'MG-ALOE', '', null].map(subMonthsOf), [12, 6, 1, 1, 1, 1]);
});

test('stored lines carry the same subscription fields as the CSV calculator', () => {
  const rows = ORDERS.flat();
  const raw = calculate(rows, new Map(Object.entries(LABELS).map(([k, v]) => [k, Number(v)])),
    {}, {}, {}, { 'MG-ALOE': 4.5, 'MG-JADE': 6 }, {}, {}, null, {}, null, null, {});
  // The calculator's own figures for the two-subscription order: the export artifact the rule below replaces.
  assert.deepEqual(raw.filter(l => l.orderNum === '#808').map(l => l.subShipMo), [0.21, 0]);
  const csvLines = markSeveralSubscriptions(raw);                  // what the dashboard does after calculate()
  const ship = normalizeShipStationRows(Object.entries(LABELS).flatMap(([order, fee], i) =>
    ssCustom({ shipment: `S${i}`, order, fee, items: [{ sku: 'X', qty: 1 }] }))).shipments;
  const snap = buildSnapshot({ weekStart: '2026-09-14', orders: csvRowsToNormalizedOrders(rows), shipments: ship, catalog: FIXTURE_CATALOG });
  const stored = storedLines(snap.orders.map(orderRow), snap.lines.map(lineRow));
  const subs = csvLines.filter(l => /^(SUB|GSUB)/i.test(l.sku));
  assert.equal(subs.length, 9);
  for (const c of subs.filter(x => x.orderNum !== '#807')) {
    const s = stored.find(x => x.orderNum === c.orderNum && x.sku === c.sku);
    assert.ok(s, c.orderNum);
    assert.deepEqual(FIELDS.map(k => s[k]), FIELDS.map(k => c[k]), `${c.orderNum} ${c.sku}`);
  }
  const by = n => stored.find(x => x.orderNum === n && /SUB/.test(x.sku));
  assert.equal(by('#801').subShipMo, 6.99, '83.88 over 12 months');
  assert.equal(by('#802').subShipMo, 5.4, '60% of $9');
  assert.equal(by('#804').subSSCostMo, null, 'no label cost yet');
  assert.equal(by('#805').subShipMo, 5.4, '$30 of $50 before the order discount: 60% of $9');
  assert.ok(by('#805').lineRevenue < 30, 'the stored line carries the allocated order discount');
  assert.equal(by('#806').subShipMo, 5.56, '$25 of $45 (after the line discount, before the refund) of $10');
  assert.equal(stored.find(x => x.sku === 'MG-ALOE').subShipMo, null, 'not a subscription line');
  const c807 = subs.find(x => x.orderNum === '#807'), s807 = by('#807');
  assert.ok(Math.abs(Math.round(s807.subShipMo * 100) - Math.round(c807.subShipMo * 100)) <= 1, `within 1¢: ${s807.subShipMo} vs ${c807.subShipMo}`);
  // Several subscriptions in one order: shipping collected, label cost and loss are unavailable on both paths.
  for (const lines of [stored, csvLines]) {
    const two = lines.filter(x => x.orderNum === '#808');
    assert.equal(two.length, 2);
    for (const l of two) assert.deepEqual([l.subShipUnavailable, l.subShipMo, l.subSSCostMo, l.subShipLoss], [true, null, null, null], l.sku);
    assert.deepEqual(two.map(l => l.subMonths), [12, 1]);
    assert.deepEqual(two.map(l => l.expSubShipMo), [6.99, 6.99]);
  }
  assert.equal(by('#802').subShipUnavailable, false, 'one subscription with a regular item: still split');
});
