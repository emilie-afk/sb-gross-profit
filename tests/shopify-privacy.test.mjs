/**
 * Shopify free-text minimum form (C1). Synthetic rows only: the free-text shapes
 * mirror those found in the real export (marketplace order-id tags, tokens and
 * URLs in note attributes, influencer codes), with invented values.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate } from '../shared/calculator.js';
import { csvOrder } from './fixtures-normalized.mjs';
import { csvRowsToNormalizedOrders } from '../shared/adapters/legacy.js';
import { sanitizeShopifyOrderRows, prepareShopifyUpload } from '../shared/adapters/shopifyCsv.js';
import { reduceShopifyOrderRows, assertReducedShopifyOrderRows, assertReducedNormalizedOrders, APPROVED_SOURCES } from '../shared/adapters/shopifyPrivacy.js';
import { parseCSV } from '../shared/calculator.js';

function rawRows() {
  const withRaw = (rows, over) => rows.map((r, i) => i === 0 ? { ...r, ...over } : r);
  return [
    ...withRaw(csvOrder({ name: '#930101', subtotal: 20, total: 20, lines: [{ sku: 'MG-ALOE', price: 10, qty: 2, vendor: 'Succulents Box' }] }),
      { 'Tags': 'Subscription, Prepaid, tiktokorderid:111111111111111111, vip synthetic@example.invalid', 'Source': 'web',
        'Note Attributes': '__route_cart_id: tok_synthetic\nutm_source: https://example.invalid/x\nChannel: amazon', 'Discount Code': 'SYNTHCREATOR20' }),
    ...withRaw(csvOrder({ name: '#930102', subtotal: 30, total: 0, lines: [{ sku: 'MG-JADE', price: 30, vendor: 'Succulents Box' }] }),
      { 'Tags': 'free sample', 'Source': 'tiktok', 'Note Attributes': 'Free sample: $30.00\nseller-id: 999', 'Discount Code': 'Free Sample' }),
    ...withRaw(csvOrder({ name: '#930103', subtotal: 45, total: 45, lines: [{ sku: 'FH-POTHOS', price: 45, vendor: 'House Plant Dropship' }] }),
      { 'Tags': '', 'Source': '294517', 'Note Attributes': '', 'Discount Code': '' }),
  ].map(r => ({ ...r, 'Email': 'synthetic@example.invalid', 'Billing Name': 'SYNTHETIC', 'Notes': 'synthetic note' }));
}
const run = rows => calculate(rows, new Map(), {}, {}, {}, {}, {}, {}, null, {}, null, null);

test('reduction keeps only what the engine reads', () => {
  const { rows, problems } = reduceShopifyOrderRows(sanitizeShopifyOrderRows(rawRows()).rows);
  assert.deepEqual(problems, []);
  assert.equal(rows[0]['Tags'], 'Subscription, Prepaid');
  assert.equal(rows[0]['Discount Code'], '');
  assert.equal(rows[0]['Note Attributes'], 'Channel: amazon');
  const b = rows.find(r => r['Name'] === '#930102' && r['Tags'] !== undefined && r['Subtotal']);
  assert.equal(b['Tags'], 'free sample');
  assert.equal(b['Discount Code'], 'sample');
  assert.equal(b['Note Attributes'], 'Free sample: $30.00');
});

test('parity: engine output on the reduced rows equals engine output on the raw rows', () => {
  const raw = rawRows();
  const reduced = reduceShopifyOrderRows(sanitizeShopifyOrderRows(raw).rows).rows;
  assert.deepEqual(run(reduced), run(raw));
});

test('the uploaded text carries no customer columns, tokens, URLs, ids or codes', () => {
  const up = prepareShopifyUpload(rawRows());
  assert.deepEqual(up.problems, []);
  for (const bad of ['synthetic@example.invalid', 'SYNTHETIC', 'synthetic note', 'tok_synthetic', 'https://', 'tiktokorderid', 'SYNTHCREATOR20', 'seller-id'])
    assert.ok(!up.text.includes(bad), bad);
  assert.doesNotThrow(() => assertReducedShopifyOrderRows(parseCSV(up.text)));
});

test('an unapproved Source or Channel is a problem, not a silent relabel', () => {
  const rows = sanitizeShopifyOrderRows(rawRows()).rows;
  rows[0]['Source'] = 'new_sales_app';
  rows[0]['Note Attributes'] = 'Channel: SomeNewMarket';
  const { problems } = reduceShopifyOrderRows(rows);
  assert.deepEqual(problems.map(p => p.rule).sort(), ['unapproved channel value', 'unapproved source value']);
  assert.ok(!JSON.stringify(problems).includes('SomeNewMarket'), 'problems never carry values');
  assert.ok(APPROVED_SOURCES.includes('294412976129'), 'a 12-digit app id is a valid source, not a phone number');
});

test('the Worker check rejects raw free text that skipped the reduction', () => {
  const rows = sanitizeShopifyOrderRows(rawRows()).rows;
  assert.throws(() => assertReducedShopifyOrderRows(rows), e => e.name === 'CustomerDataError');
  const reduced = reduceShopifyOrderRows(rows).rows;
  assert.doesNotThrow(() => assertReducedShopifyOrderRows(reduced));
  const email = reduced.map((r, i) => i === 0 ? { ...r, 'Lineitem name': 'Gift for synthetic@example.invalid' } : r);
  assert.throws(() => assertReducedShopifyOrderRows(email), e => e.name === 'CustomerDataError');
  const src = reduced.map((r, i) => i === 0 ? { ...r, 'Source': 'unknown_app' } : r);
  assert.throws(() => assertReducedShopifyOrderRows(src), e => e.code === 'unapproved_value');
});

test('the normalized (manual / backfill) path obeys the same contract', () => {
  const reduced = reduceShopifyOrderRows(sanitizeShopifyOrderRows(rawRows()).rows).rows;
  const orders = csvRowsToNormalizedOrders(reduced);
  assert.doesNotThrow(() => assertReducedNormalizedOrders(orders));
  const rawOrders = csvRowsToNormalizedOrders(sanitizeShopifyOrderRows(rawRows()).rows);
  assert.throws(() => assertReducedNormalizedOrders(rawOrders), e => e.name === 'CustomerDataError');
});
