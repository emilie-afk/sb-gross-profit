/**
 * HPD loading is deterministic: loadHpdForOrders returns rows in
 * shopify_order_number order whatever order they were stored or asked for,
 * and the week's snapshot does not depend on HPD insertion order.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loaded, ingest, admin, WEEK, makeEnv, viaNormalized } from './helpers.mjs';
import { gqlOrder } from '../../tests/fixtures-normalized.mjs';
import { loadHpdForOrders } from '../src/store.js';

const hpd = n => ({ shopifyOrderNumber: n, hpdOrderNumber: `HPD-${n}`, orderDate: '2026-09-15', carrierService: 'USPS Priority',
  netTerms: 7 + (Number(n) % 5), prepaid: 6, costDifference: 1 + (Number(n) % 5), items: [{ sku: 'FH-POTHOS', qty: 1 }] });
const NUMBERS = ['900113', '900102', '900147', '900105', '900131', '900120'];
// House Plant Dropship orders (FH- SKUs), so HPD records reach the engine.
const hpNodes = () => NUMBERS.map((n, i) => gqlOrder({ name: `#${n}`, createdAt: `2026-09-${15 + (i % 5)}T18:00:00Z`, subtotal: 24, shipping: 7, total: 31,
  lines: [{ sku: 'FH-POTHOS', price: 24, qty: 1, vendor: 'House Plant Dropship' }] }));

test('loadHpdForOrders returns shopify_order_number order, independent of storage and request order', async () => {
  const env = await makeEnv();
  for (const n of NUMBERS) assert.equal((await ingest(env, '/v1/ingest/hpd', { format: 'normalized', hpdOrders: [hpd(n)] })).status, 200);
  const sorted = [...NUMBERS].sort();
  for (const ask of [NUMBERS, [...NUMBERS].reverse(), sorted]) {
    assert.deepEqual((await loadHpdForOrders(env.DB, ask)).map(h => h.shopifyOrderNumber), sorted);
  }
  const one = (await loadHpdForOrders(env.DB, ['900147']))[0];
  assert.deepEqual([one.hpdOrderNumber, one.netTerms, one.items], ['HPD-900147', 9, [{ sku: 'FH-POTHOS', qty: 1 }]]);
});

async function weekWithHpd(order) {
  const { env } = await loaded(60);
  assert.equal((await ingest(env, '/v1/ingest/shopify', viaNormalized({ nodes: hpNodes(), weekStart: WEEK }))).status, 200);
  for (const n of order) assert.equal((await ingest(env, '/v1/ingest/hpd', { format: 'normalized', hpdOrders: [hpd(n)] })).status, 200);
  const r = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const id = r.json.snapshotId;
  // Per-environment identifiers and clock values (report version id, receivedAt) are masked; every amount stays.
  const mask = v => (typeof v === 'string' ? v.replace(/scv_[0-9a-f]{20}/g, 'scv_*').replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, 'T*') : v);
  const rows = async (sql) => (await env.DB.prepare(sql).bind(id).all()).results
    .map(({ snapshot_id: _s, ...x }) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, mask(v)])));
  return {
    totals: await rows('SELECT * FROM snapshot_totals WHERE snapshot_id = ?1'),
    orders: await rows('SELECT * FROM snapshot_order WHERE snapshot_id = ?1 ORDER BY order_name'),
    lines: await rows('SELECT * FROM snapshot_line WHERE snapshot_id = ?1 ORDER BY order_name, line_index'),
    breakdowns: await rows('SELECT * FROM snapshot_breakdown WHERE snapshot_id = ?1 ORDER BY dimension, key'),
    issues: await rows('SELECT kind, order_name, detail FROM snapshot_issue WHERE snapshot_id = ?1 ORDER BY seq'),
  };
}

test('parity: the week snapshot is identical whatever order the HPD rows were stored in', async () => {
  const a = await weekWithHpd(NUMBERS), b = await weekWithHpd([...NUMBERS].reverse()), c = await weekWithHpd([...NUMBERS].sort());
  assert.ok(a.orders.some(o => o.hpd_shipping_basis), 'HPD records reached the engine');
  assert.ok(a.totals[0].hpd_orders_actual > 0, 'HPD actual expense used');
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
});

test('HPD order is global when the order-number list spans several IN chunks', async () => {
  const env = await makeEnv();
  for (const n of NUMBERS) assert.equal((await ingest(env, '/v1/ingest/hpd', { format: 'normalized', hpdOrders: [hpd(n)] })).status, 200);
  // ~100k synthetic numbers (> one 800k-character JSON chunk); the real ones sit in different chunks, reversed.
  const filler = Array.from({ length: 100_000 }, (_, i) => String(500000 + i));
  const ask = [...[...NUMBERS].sort().reverse().slice(0, 3), ...filler, ...[...NUMBERS].sort().reverse().slice(3)];
  assert.deepEqual((await loadHpdForOrders(env.DB, ask)).map(h => h.shopifyOrderNumber), [...NUMBERS].sort());
});
