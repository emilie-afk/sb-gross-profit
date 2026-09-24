/**
 * Adapter tests: the normalized path must feed calculate() exactly what the
 * manual CSV path feeds it (A2, A3, A5), reject customer data (A11), and keep
 * the HPD log behavior of parseHpdLog().
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate, parseCSV, parseHpdLog } from '../shared/calculator.js';
import { normalizeShopifyOrders, SHOPIFY_ORDERS_QUERY } from '../shared/adapters/shopifyGraphql.js';
import { csvRowsToNormalizedOrders, toLegacyShopifyRows, attachLineKeys, toLegacyHpdMap } from '../shared/adapters/legacy.js';
import { normalizeHpdRows } from '../shared/adapters/hpd.js';
import { CustomerDataError, toStoreLocal, weekStartOf, filterNoteAttributes } from '../shared/normalized.js';
import { gqlOrder, csvOrder, FIXTURE_CATALOG } from './fixtures-normalized.mjs';
import { engineArgsFromCatalog } from '../shared/catalog.js';

const A = engineArgsFromCatalog(FIXTURE_CATALOG);
const run = (rows, ss = new Map(), hpd = null) =>
  calculate(rows, ss, A.mcgCosts, A.productCosts, A.skuWeights, A.additionalCosts, A.hpByName, A.skuAlias, hpd, A.mcgExtra, A.vendorCosts, A.vendorIndex);

const csvFixture = () => [
  ...csvOrder({ name: '#900001', subtotal: 30, shipping: 5, total: 35, lines: [
    { sku: 'MG-ALOE', price: 10, qty: 2, vendor: 'Succulents Box' },
    { sku: 'ROUTEINS', price: 0.98, name: 'Shipping Protection by Route - 0.98', vendor: 'Route' },
    { sku: 'MG-JADE', price: 9.02, vendor: 'Succulents Box' }] }),
  ...csvOrder({ name: '#900002', subtotal: 20, shipping: 0, total: 20, refunded: 5, lines: [
    { sku: 'FH-POTHOS', price: 20, vendor: 'House Plant Dropship' }] }),
  ...csvOrder({ name: '#900003', subtotal: 40, total: 40, cancelledAt: '2026-09-16 09:00:00 -0700', lines: [
    { sku: 'MG-ALOE', price: 40, vendor: 'Succulents Box' }] }),
  ...csvOrder({ name: '#900004', subtotal: 13.99, total: 13.99, lines: [{ sku: '', price: 13.99, name: 'Reshipping fee' }] }),
  ...csvOrder({ name: '#900005', subtotal: 83.88, shipping: 83.88, total: 167.76, source: 'subscription_contract_checkout_one',
    lines: [{ sku: 'SUB2-2-12', price: 83.88 }] }),
  ...csvOrder({ name: '#900006', subtotal: 27, shipping: 5, total: 32, discountAmount: 3, noteAttributes: 'Channel: amazon\nGift message: private text',
    tags: 'wholesale, vip', lines: [
    { sku: 'LM-VASE-PRO-BUD-RAINBOW', price: 30, vendor: 'LindaMakes', discount: 3 }] }),
];

test('A2/A3: CSV → normalized → legacy rows gives calculate() byte-identical lines', () => {
  const rows = csvFixture();
  const direct = run(rows);
  const orders = csvRowsToNormalizedOrders(rows);
  const { rows: rows2, keys } = toLegacyShopifyRows(orders);
  assert.deepStrictEqual(run(rows2), direct);
  const keyed = attachLineKeys(run(rows2), rows2, keys);
  assert.equal(keyed.length, direct.length);
  assert.ok(keyed.every(l => Number.isInteger(l.lineIndex)));
});

test('legacy rows carry order-level columns on the first row only, as Shopify does', () => {
  const orders = csvRowsToNormalizedOrders(csvFixture());
  const { rows } = toLegacyShopifyRows(orders);
  const o1 = rows.filter(r => r['Name'] === '#900001');
  assert.equal(o1.length, 3);
  assert.equal(o1[0]['Total'], '35.00');
  for (const r of o1.slice(1)) {
    for (const c of ['Total', 'Subtotal', 'Shipping', 'Taxes', 'Refunded Amount', 'Source', 'Tags', 'Note Attributes', 'Cancelled at']) assert.equal(r[c], '', c);
    assert.equal(r['Created at'], o1[0]['Created at']);
  }
});

test('note attributes keep only the keys the engine reads; free text is dropped', () => {
  const orders = csvRowsToNormalizedOrders(csvFixture());
  const o6 = orders.find(o => o.orderName === '#900006');
  assert.deepEqual(o6.noteAttributes, [{ key: 'Channel', value: 'amazon' }]);
  assert.deepEqual(filterNoteAttributes([{ key: 'Free sample', value: '$28.86' }, { key: 'Gift note', value: 'x' }]),
    [{ key: 'Free sample', value: '$28.86' }]);
});

test('attachLineKeys refuses a misaligned engine output', () => {
  const orders = csvRowsToNormalizedOrders(csvFixture());
  const { rows, keys } = toLegacyShopifyRows(orders);
  const lines = run(rows);
  assert.throws(() => attachLineKeys(lines.slice(1), rows, keys), /alignment/);
});

test('A5: a GraphQL order and the same order as CSV give the same engine lines', () => {
  const gql = normalizeShopifyOrders([gqlOrder({ name: '#900010', createdAt: '2026-09-15T17:04:12Z',
    subtotal: 30, shipping: 5, total: 35, lines: [
      { sku: 'MG-ALOE', price: 10, qty: 2, vendor: 'Succulents Box' },
      { sku: 'MG-JADE', price: 10, vendor: 'Succulents Box' }] })]);
  const csv = csvRowsToNormalizedOrders(csvOrder({ name: '#900010', createdAt: '2026-09-15 10:04:12 -0700',
    subtotal: 30, shipping: 5, total: 35, lines: [
      { sku: 'MG-ALOE', price: 10, qty: 2, vendor: 'Succulents Box' },
      { sku: 'MG-JADE', price: 10, vendor: 'Succulents Box' }] }));
  const a = run(toLegacyShopifyRows(gql).rows), b = run(toLegacyShopifyRows(csv).rows);
  assert.deepStrictEqual(a, b);
  assert.equal(gql[0].createdAtLocal, '2026-09-15 10:04:12 -0700');
});

test('A11: GraphQL input carrying customer fields is rejected, never normalized', () => {
  const bad = gqlOrder({ subtotal: 10, total: 10, lines: [{ sku: 'MG-ALOE', price: 10 }] });
  bad.customer = { firstName: 'Synthetic' };
  assert.throws(() => normalizeShopifyOrders([bad]), CustomerDataError);
  const bad2 = gqlOrder({ subtotal: 10, total: 10, lines: [{ sku: 'MG-ALOE', price: 10 }] });
  bad2.shippingAddress = { city: 'Nowhere' };
  assert.throws(() => normalizeShopifyOrders([bad2]), CustomerDataError);
  const bad3 = gqlOrder({ subtotal: 10, total: 10, lines: [{ sku: 'MG-ALOE', price: 10 }] });
  bad3.email = 'synthetic@example.invalid';
  assert.throws(() => normalizeShopifyOrders([bad3]), CustomerDataError);
});

test('the approved GraphQL query selects no customer, address, email, phone or note field', () => {
  for (const f of ['customer', 'email', 'phone', 'shippingAddress', 'billingAddress', 'note ', 'displayAddress']) {
    assert.ok(!SHOPIFY_ORDERS_QUERY.includes(f), f);
  }
  for (const f of ['discountAllocations', 'refundLineItems', 'refundShippingLines', 'orderAdjustments', 'currentQuantity', 'requiresShipping']) {
    assert.ok(SHOPIFY_ORDERS_QUERY.includes(f), f);
  }
});

test('store time zone: an evening UTC order lands on its local business date', () => {
  assert.equal(toStoreLocal('2026-09-15T05:30:00Z'), '2026-09-14 22:30:00 -0700');
  assert.equal(toStoreLocal('2026-12-15T05:30:00Z'), '2026-12-14 21:30:00 -0800');
  const [o] = normalizeShopifyOrders([gqlOrder({ createdAt: '2026-09-15T05:30:00Z', subtotal: 1, total: 1, lines: [{ sku: 'MG-ALOE', price: 1 }] })]);
  assert.equal(o.businessDate, '2026-09-14');
  assert.equal(weekStartOf('2026-09-14'), '2026-09-14');   // Monday
  assert.equal(weekStartOf('2026-09-20'), '2026-09-14');   // Sunday
  assert.equal(weekStartOf('2026-09-21'), '2026-09-21');
});

test('GraphQL discount allocations become the line discount, with their source', () => {
  const [o] = normalizeShopifyOrders([gqlOrder({ subtotal: 27, total: 27, discounts: 3, lines: [
    { sku: 'MG-ALOE', price: 20, allocations: [{ amount: 2 }] }, { sku: 'MG-JADE', price: 10, allocations: [{ amount: 1 }] }] })]);
  assert.deepEqual(o.lines.map(l => l.lineDiscount), [2, 1]);
  assert.deepEqual(o.lines.map(l => l.discountSource), ['shopify_line_allocation', 'shopify_line_allocation']);
  assert.equal(o.lines[0].discountAllocations[0].code, 'TEST10');
});

test('HPD adapter matches parseHpdLog and keeps neither buyer notes nor ship-to state', () => {
  const csv = [
    'Date - Order Date,Order - Number,Carrier - Service Selected,Ship To - State,Item - Qty,Item - SKU,Notes - From Buyer,Actual Net Terms Cost (Labor + Carrier Shipping),Prepaid Fixed Price,Cost Difference (Net Terms - Prepaid)',
    '2026-09-15,HPD-1,USPS Ground,ZZ,1,FH-POTHOS,"<br/>#900002<br/>synthetic buyer note",12.40,10.00,2.40',
    '2026-09-15,HPD-1,USPS Ground,ZZ,2,FH-FERN,,,,',
    ',,,,,,,,,',
  ].join('\n');
  const legacy = parseHpdLog(csv);
  const norm = toLegacyHpdMap(normalizeHpdRows(parseCSV(csv)));
  const a = legacy.get('900002'), b = norm.get('900002');
  for (const k of ['hpdOrderNum', 'shopifyOrderNum', 'netTerms', 'prepaid', 'costDiff', 'items']) assert.deepEqual(b[k], a[k], k);
  const stored = JSON.stringify(normalizeHpdRows(parseCSV(csv)));
  assert.ok(!stored.includes('synthetic buyer note'));
  assert.ok(!stored.includes('"ZZ"'));
});
