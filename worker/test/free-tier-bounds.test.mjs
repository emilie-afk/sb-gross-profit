/**
 * Free-tier path: per-request work is bounded by ORDERS_PER_PART, not by the week's size.
 *  - every stored result part holds at most 40 orders' rows;
 *  - order lists (any sort or filter) and order details are answered in D1 over the parts' stored text;
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

test('bounded parts: a 300-order week is stored as ≤ 40-order parts; lists and details read no part body', async () => {
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
  // Lists: D1 sorts, filters and pages over the stored part text; the Worker reads no part body.
  let list;
  for (const qs of ['sort=gp_asc', 'sort=date_desc', 'sort=revenue_desc', 'sort=date_asc', 'channel=Retail&sort=date_desc', 'missingCost=true&sort=revenue_desc']) {
    spy.seen.length = 0;
    const r = (await api(env, 'GET', `/v1/snapshot/${week}/orders?includeDrafts=1&${qs}&limit=25`)).json;
    if (qs === 'sort=gp_asc') { list = r; assert.equal(r.orders.length, 25); }
    assert.ok(r.orders.length <= 25 && r.page.total <= total);
    assert.equal(spy.seen.filter(p => /^(orders|lines):|orderindex/.test(p)).length, 0, `${qs}: no part body read (${spy.seen.join(',')})`);
  }
  spy.seen.length = 0;
  const one = (await api(env, 'GET', `/v1/snapshot/${week}/orders/${encodeURIComponent(list.orders[7].orderName)}?includeDrafts=1`)).json;
  assert.equal(one.order.orderName, list.orders[7].orderName);
  assert.equal(spy.seen.filter(p => /^(orders|lines):|orderindex/.test(p)).length, 0, 'an order detail is found in D1; no part body is read');
  assert.ok(one.lines.length >= 1);
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

test('aux pin: the manifest is the same with or without it; unchanged pins write nothing; any change to the aux tables invalidates it', async () => {
  const { changes } = await import('./freeTierHarness.mjs');
  const d = dataset({ n: 240, scr: { zeroEvery: 1e9 } });
  const ft = await freeTierRun(d, { verify: false });
  const env = ft.env, c = ft.c, week = d.weeks[6];
  const strip = m => { const { asOf: _a, ...x } = m.manifest; return stableStringify(x); };
  const { stableStringify } = await import('../../shared/normalized.js');
  await env.DB.prepare('DELETE FROM aux_pin').run();
  const inline = await c.call('GET', `/v1/collect/weeks/${week}/manifest`);
  const p1 = await c.call('POST', `/v1/collect/weeks/${week}/aux-pin`, { json: {} });
  assert.equal(p1.pinned, 'pinned');
  // The manifest now takes the hashes from the pin and skips the shipment queries.
  let shipQueries = 0; const orig = env.DB.prepare.bind(env.DB);
  env.DB.prepare = sql => { if (/FROM shipment\b|FROM hpd_order\b/.test(sql)) shipQueries++; return orig(sql); };
  const pinned = await c.call('GET', `/v1/collect/weeks/${week}/manifest`);
  env.DB.prepare = orig;
  assert.equal(shipQueries, 0, 'no shipment or HPD rows read with a valid pin');
  assert.equal(strip(pinned), strip(inline), 'the same manifest, aux hashes included');
  assert.deepEqual(pinned.manifest.aux, inline.manifest.aux);
  // Unchanged: no write. A snapshot write or a settings change does not touch aux_n.
  const t0 = changes(env);
  assert.equal((await c.call('POST', `/v1/collect/weeks/${week}/aux-pin`, { json: {} })).pinned, 'unchanged');
  assert.equal(changes(env) - t0, 0, 'an unchanged pin writes 0 rows');
  await api(env, 'POST', '/v1/admin/settings', { mcg_free_shipping_threshold: 77, reason: 'test: not an aux input' });
  assert.equal((await c.call('POST', `/v1/collect/weeks/${week}/aux-pin`, { json: {} })).pinned, 'unchanged');
  // A ShipStation write (any week) raises aux_n: the pin is stale, the manifest hashes inline again.
  const s = await env.DB.prepare("SELECT shipment_no FROM shipment WHERE order_number IN (SELECT order_number FROM ord_ptr WHERE week_start = ?1) LIMIT 1").bind(week).first();
  await env.DB.prepare("UPDATE shipment SET carrier_fee = COALESCE(carrier_fee, 0) + 1 WHERE shipment_no = ?1").bind(s.shipment_no).run();
  shipQueries = 0; env.DB.prepare = sql => { if (/FROM shipment\b/.test(sql)) shipQueries++; return orig(sql); };
  const stale = await c.call('GET', `/v1/collect/weeks/${week}/manifest`);
  env.DB.prepare = orig;
  assert.ok(shipQueries > 0, 'a stale pin is not used');
  assert.notEqual(stale.manifest.aux.shipmentsHash, inline.manifest.aux.shipmentsHash, 'the changed shipment is in the hash');
  assert.equal((await c.call('POST', `/v1/collect/weeks/${week}/aux-pin`, { json: {} })).pinned, 'pinned');
  assert.deepEqual((await c.call('GET', `/v1/collect/weeks/${week}/manifest`)).manifest.aux, stale.manifest.aux);
  // The pinned hash equals the hash of what GET …/aux serves (what the verifier checks).
  const { auxHash } = await import('../../shared/bundle.js');
  const aux = await c.call('GET', `/v1/collect/weeks/${week}/aux`);
  assert.equal(await auxHash(aux.shipments), stale.manifest.aux.shipmentsHash);
  assert.equal(await auxHash(aux.hpdOrders), stale.manifest.aux.hpdHash);
});
