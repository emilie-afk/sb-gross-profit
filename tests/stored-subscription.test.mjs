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
import { storedLines, subMonthsOf } from '../js/storedReport.js';
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
].map((rows, i) => rows.map(r => ({ ...r, 'Created at': `2026-09-1${5 + i} 10:00:00 -0700` })));
const LABELS = { '801': '7.40', '802': '8.10', '803': '6.25' };
const FIELDS = ['subMonths', 'subShipMo', 'expSubShipMo', 'subSSCostMo', 'subShipLoss'];

test('subscription SKU months: the last number of 1–24; 1 for other SKUs', () => {
  assert.deepEqual(['SUB5-1-12', 'GSUB3-1-6', 'SUB2-1-POT', 'MG-ALOE', '', null].map(subMonthsOf), [12, 6, 1, 1, 1, 1]);
});

test('stored lines carry the same subscription fields as the CSV calculator', () => {
  const rows = ORDERS.flat();
  const csvLines = calculate(rows, new Map(Object.entries(LABELS).map(([k, v]) => [k, Number(v)])),
    {}, {}, {}, { 'MG-ALOE': 4.5 }, {}, {}, null, {}, null, null, {});
  const ship = normalizeShipStationRows(Object.entries(LABELS).flatMap(([order, fee], i) =>
    ssCustom({ shipment: `S${i}`, order, fee, items: [{ sku: 'X', qty: 1 }] }))).shipments;
  const snap = buildSnapshot({ weekStart: '2026-09-14', orders: csvRowsToNormalizedOrders(rows), shipments: ship, catalog: FIXTURE_CATALOG });
  const stored = storedLines(snap.orders.map(orderRow), snap.lines.map(lineRow));
  const subs = csvLines.filter(l => /^(SUB|GSUB)/i.test(l.sku));
  assert.equal(subs.length, 4);
  for (const c of subs) {
    const s = stored.find(x => x.orderNum === c.orderNum && x.sku === c.sku);
    assert.ok(s, c.orderNum);
    assert.deepEqual(FIELDS.map(k => s[k]), FIELDS.map(k => c[k]), `${c.orderNum} ${c.sku}`);
  }
  const by = n => stored.find(x => x.orderNum === n && /SUB/.test(x.sku));
  assert.equal(by('#801').subShipMo, 6.99, '83.88 over 12 months');
  assert.equal(by('#802').subShipMo, 5.4, '60% of $9');
  assert.equal(by('#804').subSSCostMo, null, 'no label cost yet');
  assert.equal(stored.find(x => x.sku === 'MG-ALOE').subShipMo, null, 'not a subscription line');
});
