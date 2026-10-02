/**
 * Free-tier path: per-request work is bounded by ORDERS_PER_PART, not by the week's size.
 *  - every stored result part holds at most 40 orders' rows;
 *  - the default order list (gp_asc) and an order's detail read one or two order parts;
 *  - finalize does not rebuild the manifest when no input was written since it was issued.
 * (Equality of every read with today's Worker path is covered in free-tier.test.mjs.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { api, dataset, freeTierRun } from './freeTierHarness.mjs';
import * as FT from '../../automation/collector/src/freeTier.mjs';
import { ORDERS_PER_PART } from '../../shared/resultParts.js';

const partsRead = env => {
  const seen = [];
  const orig = env.DB.prepare.bind(env.DB);
  env.DB.prepare = sql => {
    const st = orig(sql);
    if (!/FROM snapshot_blob/.test(sql)) return st;
    const bind = st.bind.bind(st);
    st.bind = (...a) => { seen.push(...a.filter(x => typeof x === 'string' && x.startsWith('[')).flatMap(x => JSON.parse(x)), ...a.filter(x => typeof x === 'string' && /^(orders|lines|scenario):|orderindex|sections/.test(x))); return bind(...a); };
    return st;
  };
  return { seen, restore: () => { env.DB.prepare = orig; } };
};

test('bounded parts: a 300-order week is stored as ≤ 40-order parts; list and detail reads touch one or two of them', async () => {
  const d = dataset({ n: 2700, lastWeek: '2020-03-09', prefix: '5' });           // ≈ 300 orders per week
  const ft = await freeTierRun(d, { verify: false });
  const env = ft.env, week = d.weeks[7];
  const snap = ft.results.find(r => r.weekStart === week);
  const rows = (await env.DB.prepare('SELECT part, body FROM snapshot_blob WHERE snapshot_id = ?1').bind(snap.snapshotId).all()).results;
  const text = r => zlib.gunzipSync(Buffer.from(r.body)).toString();
  const orderParts = rows.filter(r => r.part.startsWith('orders:'));
  assert.ok(orderParts.length >= 6, `several order parts (${orderParts.length})`);
  for (const r of orderParts) assert.ok(JSON.parse(text(r)).orders.length <= ORDERS_PER_PART);
  for (const r of rows) assert.ok(text(r).length <= 512 * 1024, `${r.part} within the part cap`);
  const total = orderParts.reduce((n, r) => n + JSON.parse(text(r)).orders.length, 0);
  const index = JSON.parse(text(rows.find(r => r.part === 'orderindex'))).orders;
  assert.equal(index.length, total);

  const spy = partsRead(env);
  const list = (await api(env, 'GET', `/v1/snapshot/${week}/orders?includeDrafts=1&sort=gp_asc&limit=25`)).json;
  assert.equal(list.orders.length, 25);
  const read = spy.seen.filter(p => p.startsWith('orders:')).length;
  assert.ok(read >= 1 && read <= 2, `default page reads 1–2 of ${orderParts.length} order parts (${spy.seen.join(',')})`);
  spy.seen.length = 0;
  const one = (await api(env, 'GET', `/v1/snapshot/${week}/orders/${encodeURIComponent(list.orders[7].orderName)}?includeDrafts=1`)).json;
  assert.equal(one.order.orderName, list.orders[7].orderName);
  assert.deepEqual(spy.seen.filter(p => /^(orders|lines):/.test(p)).length, 2, 'an order detail reads one order part and its line part');
  spy.restore();
});

test('finalize: with no input written since the manifest was issued, the manifest is not rebuilt', async () => {
  const d = dataset({ n: 120, scr: { zeroEvery: 1e9 } });
  const ft = await freeTierRun(d, { verify: false });
  const env = ft.env, c = ft.c, week = d.weeks[7];
  await api(env, 'POST', '/v1/admin/settings', { mcg_free_shipping_threshold: 88, reason: 'test: force a new revision' });
  let batches = 0, finalizing = false;
  const realBatch = env.DB.batch.bind(env.DB);
  env.DB.batch = async s => { if (finalizing) batches++; return realBatch(s); };
  const realCall = c.call;
  c.call = async (m, p, o) => { finalizing = /\/finalize$/.test(p); try { return await realCall(m, p, o); } finally { finalizing = false; } };
  const r = await FT.computeAndUploadWeek(c, week, ft.cache);
  assert.equal(r.status, 'computed');
  assert.equal(batches, 2, 'finalize = one read batch + the commit (no manifest rebuild)');
  c.call = realCall; env.DB.batch = realBatch;
});

test('bounded reads: order pages are at most 100; scenario input is paged by 40 orders; manifest hashes equal their definitions', async () => {
  const d = dataset({ n: 900, lastWeek: '2020-03-09', prefix: '4' });             // ≈ 100 orders per week
  const ft = await freeTierRun(d, { verify: false });
  const env = ft.env, week = d.weeks[7];
  assert.equal((await api(env, 'GET', `/v1/snapshot/${week}/orders?includeDrafts=1&limit=101`)).status, 400);
  const p = (await api(env, 'GET', `/v1/snapshot/${week}/orders?includeDrafts=1&limit=100`)).json;
  assert.ok(p.orders.length <= 100 && p.page.total > 40);
  const s0 = (await api(env, 'GET', `/v1/snapshot/${week}/scenario-input?includeDrafts=1`)).json;
  assert.equal(s0.page.index, 0);
  assert.equal(s0.page.count, Math.ceil(p.page.total / 40));
  assert.ok(new Set(s0.lines.map(l => l.orderNum)).size <= 40);
  assert.equal((await api(env, 'GET', `/v1/snapshot/${week}/scenario-input?includeDrafts=1&page=${s0.page.count}`)).status, 404);
  const { stableStringify } = await import('../../shared/normalized.js');
  const { sha256Text } = await import('../src/gz.js');
  const { inputsHashOf } = await import('../src/collectWeeks.js');
  const m = await ft.c.call('GET', `/v1/collect/weeks/${week}/manifest`);
  assert.equal(m.manifestHash, await sha256Text(stableStringify(m.manifest)));
  const snap = await env.DB.prepare('SELECT manifest_hash FROM snapshot WHERE snapshot_id = ?1').bind(m.existing.snapshotId).first();
  assert.equal(snap.manifest_hash, await inputsHashOf(m.manifest), 'the week is recognised as unchanged');
});
