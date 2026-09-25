/**
 * Automation P1: sanitized csv_text uploads from the Windows collector.
 * Synthetic orders and shipments only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, ingest, admin, catalog, WEEK } from './helpers.mjs';
import { csvOrder, ssCustom, ssTemplate } from '../../tests/fixtures-normalized.mjs';
import { csvRowsToNormalizedOrders } from '../../shared/adapters/legacy.js';
import { sanitizeShopifyOrderRows, toCsvText, SHOPIFY_ORDERS_CSV_COLUMNS } from '../../shared/adapters/shopifyCsv.js';

const csv = rows => { const cols = Object.keys(rows[0]); return toCsvText(rows, cols); };
const sha256 = async t => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map(b => b.toString(16).padStart(2, '0')).join('');

function shopifyRows() {
  return [
    ...csvOrder({ name: '#910001', createdAt: '2026-09-15 10:00:00 -0700', subtotal: 20, shipping: 5, total: 25,
      noteAttributes: 'Channel: web',
      lines: [{ sku: 'MG-ALOE', price: 10, qty: 2, vendor: 'Succulents Box' }] }),
    ...csvOrder({ name: '#910002', createdAt: '2026-09-16 18:30:00 -0700', subtotal: 18, shipping: 0, total: 16.2, discountAmount: 1.8,
      lines: [{ sku: 'MG-JADE', price: 18, qty: 1, discount: 1.8, vendor: 'Succulents Box' }] }),
    // An earlier order refunded this week: the rolling export carries it too.
    ...csvOrder({ name: '#909001', createdAt: '2026-09-02 09:00:00 -0700', subtotal: 45, shipping: 9, total: 54, refunded: 10,
      lines: [{ sku: 'FH-POTHOS', price: 45, qty: 1, vendor: 'House Plant Dropship' }] }),
  ];
}
/** What Shopify's raw export adds: customer columns the collector must strip. */
const withCustomerColumns = rows => rows.map(r => ({ ...r, 'Email': 'synthetic@example.invalid', 'Billing Name': 'SYNTHETIC',
  'Shipping Address1': '1 Synthetic Way', 'Phone': '+10000000000', 'Notes': 'synthetic note' }));
const shipRows = () => [                  // exactly the saved template's columns
  ...ssTemplate({ shipment: 'SX1', order: '910001', fee: '5.10', items: [{ sku: 'MG-ALOE', qty: 2 }] }),
  ...ssTemplate({ shipment: 'SX2', order: '910002', fee: '', rate: '4.40', items: [{ sku: 'MG-JADE', qty: 1 }] }),
];

async function runsFor(env) {
  return (await env.DB.prepare('SELECT source, mode, status, week_start FROM ingest_run ORDER BY started_at').all()).results;
}

test('ShipStation csv_text: new content is source_received; identical content is source_no_change (200) with no new shipments', async () => {
  const env = await makeEnv();
  const text = csv(shipRows());
  const a = await ingest(env, '/v1/ingest/shipstation', { format: 'csv_text', text, weekStart: WEEK, sanitizedSha256: await sha256(text) });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(a.json.sourceStatus, 'source_received');
  assert.equal(a.json.sourceHash, await sha256(text));
  const count = async () => (await env.DB.prepare('SELECT COUNT(*) n FROM shipment').first()).n;
  const n1 = await count();
  const b = await ingest(env, '/v1/ingest/shipstation', { format: 'csv_text', text, weekStart: WEEK });
  assert.equal(b.status, 200);
  assert.equal(b.json.sourceStatus, 'source_no_change');
  assert.equal(b.json.rowsWritten, 0);
  assert.equal(await count(), n1);
  const up = await env.DB.prepare("SELECT times_received FROM source_upload WHERE source = 'shipstation'").first();
  assert.equal(up.times_received, 2);
});

test('ShipStation csv_text with a customer column is rejected, and the run is recorded failed', async () => {
  const env = await makeEnv();
  const text = csv(ssCustom({ shipment: 'SX9', order: '910009', fee: '5' }));   // fixture carries Recipient
  const r = await ingest(env, '/v1/ingest/shipstation', { format: 'csv_text', text, weekStart: WEEK });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'customer_data_rejected');
  assert.ok(!JSON.stringify(r.json).includes('SYNTHETIC RECIPIENT'), 'values never echoed');
  assert.deepEqual((await runsFor(env)).map(x => x.status), ['failed']);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM source_upload').first()).n, 0);
});

test('csv_text needs weekStart and a matching sanitizedSha256', async () => {
  const env = await makeEnv();
  const text = csv(shipRows());
  assert.equal((await ingest(env, '/v1/ingest/shipstation', { format: 'csv_text', text })).status, 400);
  const m = await ingest(env, '/v1/ingest/shipstation', { format: 'csv_text', text, weekStart: WEEK, sanitizedSha256: 'f'.repeat(64) });
  assert.deepEqual([m.status, m.json.error], [400, 'hash_mismatch']);
  assert.equal((await runsFor(env)).length, 0, 'refused before a run starts');
});

test('the collector sanitizer keeps only allowlisted columns and engine note attributes', () => {
  const raw = withCustomerColumns(shopifyRows()).map((r, i) => i === 0 ? { ...r, 'Note Attributes': 'Channel: web\nGift message: SYNTHETIC' } : r);
  const s = sanitizeShopifyOrderRows(raw);
  assert.deepEqual(s.droppedColumns.sort(), ['Billing Name', 'Email', 'Notes', 'Phone', 'Shipping Address1']);
  assert.ok(s.columns.every(c => SHOPIFY_ORDERS_CSV_COLUMNS.includes(c)));
  const text = toCsvText(s.rows, s.columns);
  for (const bad of ['synthetic@example.invalid', 'Synthetic Way', '+10000000000', 'synthetic note', 'Gift message']) assert.ok(!text.includes(bad), bad);
  assert.ok(text.includes('Channel: web'));
});

test('Shopify csv_text: an unsanitized upload (customer column or free-text note attribute) is rejected', async () => {
  const env = await makeEnv();
  const r1 = await ingest(env, '/v1/ingest/shopify', { format: 'csv_text', mode: 'rolling', text: csv(withCustomerColumns(shopifyRows())), weekStart: WEEK });
  assert.deepEqual([r1.status, r1.json.error], [400, 'customer_data_rejected']);
  const rows = shopifyRows(); rows[0]['Note Attributes'] = 'Channel: web\nGift message: SYNTHETIC';
  const r2 = await ingest(env, '/v1/ingest/shopify', { format: 'csv_text', mode: 'rolling', text: csv(rows), weekStart: WEEK });
  assert.deepEqual([r2.status, r2.json.error], [400, 'customer_data_rejected']);
  assert.ok(!JSON.stringify([r1.json, r2.json]).includes('SYNTHETIC'));
  assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM shopify_order').first()).n, 0);
});

test('Shopify rolling csv_text records the week run and an updated_since companion; readiness sees both', async () => {
  const env = await makeEnv();
  const s = sanitizeShopifyOrderRows(withCustomerColumns(shopifyRows()));
  const r = await ingest(env, '/v1/ingest/shopify', { format: 'csv_text', mode: 'rolling', text: toCsvText(s.rows, s.columns), weekStart: WEEK });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.mode, 'week');
  assert.ok(r.json.updatedSinceRunId);
  assert.equal(r.json.sourceStatus, 'source_received');
  assert.deepEqual((await runsFor(env)).map(x => [x.source, x.mode, x.status]), [['shopify', 'week', 'ok'], ['shopify', 'updated_since', 'ok']]);
  const ready = await admin(env, 'GET', `/v1/admin/readiness?weekStart=${WEEK}`);
  assert.equal(ready.json.sources.shopify.status, 'ok');
  assert.equal(ready.json.sources.shopify_updates.status, 'ok');
  assert.ok(ready.json.missing.includes('shipping_cost_report:missing'), 'still waits for the Shipping Cost Report');
  // Re-sending the same sanitized export: success, no_change, nothing rewritten.
  const again = await ingest(env, '/v1/ingest/shopify', { format: 'csv_text', mode: 'rolling', text: toCsvText(s.rows, s.columns), weekStart: WEEK });
  assert.deepEqual([again.status, again.json.sourceStatus, again.json.rowsWritten], [200, 'source_no_change', 0]);
});

test('a failed Shopify upload records no companion run', async () => {
  const env = await makeEnv();
  const rows = shopifyRows().map(({ 'Lineitem sku': _s, ...r }) => r);        // required column missing
  const r = await ingest(env, '/v1/ingest/shopify', { format: 'csv_text', mode: 'rolling', text: csv(rows), weekStart: WEEK });
  assert.equal(r.status, 400);
  assert.deepEqual((await runsFor(env)).map(x => [x.mode, x.status]), [['week', 'failed']]);
});

test('manual-upload and automated csv_text paths reconcile to the same snapshot totals', async () => {
  const rows = shopifyRows();
  const auto = await makeEnv(), manual = await makeEnv();
  for (const env of [auto, manual]) assert.equal((await ingest(env, '/v1/ingest/catalog', catalog())).status, 200);
  // Automated: sanitized CSV text, as the collector sends it.
  const s = sanitizeShopifyOrderRows(withCustomerColumns(rows));
  assert.equal((await ingest(auto, '/v1/ingest/shopify', { format: 'csv_text', mode: 'rolling', text: toCsvText(s.rows, s.columns), weekStart: WEEK })).status, 200);
  assert.equal((await ingest(auto, '/v1/ingest/shipstation', { format: 'csv_text', text: csv(shipRows()), weekStart: WEEK })).status, 200);
  // Manual: the same export normalized by the manual/backfill adapter.
  assert.equal((await ingest(manual, '/v1/ingest/shopify', { format: 'normalized', orders: csvRowsToNormalizedOrders(rows), storeTimezone: 'America/Los_Angeles', weekStart: WEEK })).status, 200);
  assert.equal((await ingest(manual, '/v1/ingest/shipstation', { format: 'rows', rows: shipRows(), weekStart: WEEK })).status, 200);
  const a = await admin(auto, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  const m = await admin(manual, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  const totals = async (env, snapshotId) => {
    const { snapshot_id: _id, ...t } = await env.DB.prepare('SELECT * FROM snapshot_totals WHERE snapshot_id = ?1').bind(snapshotId).first();
    return t;
  };
  const ta = await totals(auto, a.json.snapshotId);
  assert.ok(ta.operating_revenue > 0);
  assert.deepEqual(ta, await totals(manual, m.json.snapshotId));
});
