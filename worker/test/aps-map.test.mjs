/**
 * Air Plant Shop scenario input on the Worker: stored apart from results (no snapshot, catalog or revision
 * changes), versions kept, identical content writes nothing, the newest export wins, reader access only
 * for published weeks, bounded reads.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { makeEnv } from './helpers.mjs';
import { buildApsMap } from '../../shared/apsMapping.js';

const ORIGIN = 'https://w.local';
async function call(env, method, path, { body, cls } = {}) {
  const h = { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' };
  if (cls === 'ingest') h['X-Ingest-Secret'] = env.INGEST_SECRET;
  if (cls === 'reader') h['X-Dashboard-Reader-Secret'] = env.DASHBOARD_READER_SECRET;
  const r = await worker.fetch(new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* not JSON */ }
  return { status: r.status, json: j };
}
const R = (ship, order, sku, date = '9/22/2026') => ({ 'Shipment ID': ship, 'Order Number': order, 'Tracking Number': '', 'Ship Date': date, 'Modify Date': '',
  'Void Flag': 'false', 'Void Date': '', Carrier: 'UPS', Service: 'Ground', 'Carrier Fee': '7', Rate: '7', 'Insurance Cost': '0', 'Shipping Paid': '9',
  Provider: '', 'Carrier Transaction ID': '', 'Internal Transaction ID': '', 'External ID': '', 'No Postage': 'false', 'Store Name': 'SB', 'Package Count': '1',
  Weight: '10', 'Item SKU': sku, 'Item Quantity': '1' });
const payload = (rows, window, sha, exportedAt) => { const m = buildApsMap(rows, { window, source: { sanitizedSha256: sha, exportedAt } }); return { meta: m.meta, orders: m.orders }; };
const tableCounts = env => Object.fromEntries(['snapshot', 'snapshot_blob', 'cost_catalog', 'reporting_run', 'ingest_run', 'automation_event']
  .map(t => [t, env.DB.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));

test('APS mapping: stored separately, versions kept, idempotent, newest export wins, published weeks only', async () => {
  const env = await makeEnv({ DASHBOARD_READER_SECRET: 'r'.repeat(40) });
  const db = env.DB.db;
  // A published week (Sep 21) and a held one (Sep 28), as stored snapshots look to the reader route.
  for (const [w, st] of [['2026-09-21', 'published'], ['2026-09-28', 'blocked']]) {
    db.prepare(`INSERT INTO snapshot (snapshot_id, week_start, revision, status, computed_at, engine_version, policy, profitability_status, storage)
      VALUES (?, ?, 1, ?, '2026-10-05T00:00:00Z', 'e', '{}', 'provisional', 'chunked')`).run(`snp_${w.replace(/-/g, '')}000000000000`, w, st);
  }
  const before = tableCounts(env);
  const W1 = { from: '2026-08-10', to: '2026-10-04' };
  const rows = [R('S1', '1001', 'AS-T-1'), R('S2', '1002', 'AS-T-1'), R('S3', '1002', 'S2KY1048', '9/23/2026'), R('S4', '1003', 'MG-ALOE')];
  const p1 = payload(rows, W1, 'a'.repeat(64), '2026-10-05T08:00:00Z');
  const w0 = db.prepare('SELECT total_changes() AS n').get().n;
  const r1 = await call(env, 'POST', '/v1/collect/aps-map', { body: p1, cls: 'ingest' });
  assert.equal(r1.status, 200, JSON.stringify(r1.json)); assert.equal(r1.json.sourceStatus, 'source_received');
  const writes1 = db.prepare('SELECT total_changes() AS n').get().n - w0;
  // Identical content: no new version, nothing written to the mapping tables.
  const m0 = db.prepare('SELECT (SELECT COUNT(*) FROM aps_map_version) + (SELECT COUNT(*) FROM aps_map_order) AS n').get().n;
  const r2 = await call(env, 'POST', '/v1/collect/aps-map', { body: p1, cls: 'ingest' });
  assert.equal(r2.json.sourceStatus, 'source_no_change');
  assert.equal(db.prepare('SELECT (SELECT COUNT(*) FROM aps_map_version) + (SELECT COUNT(*) FROM aps_map_order) AS n').get().n, m0);
  // A newer export (next week) changes order 1002 to mixed; an older export arriving late never replaces it.
  const rows2 = [R('S1', '1001', 'AS-T-1'), R('S2', '1002', 'AS-T-1'), R('S2', '1002', 'S2KY1048')];
  await call(env, 'POST', '/v1/collect/aps-map', { body: payload(rows2, { from: '2026-08-17', to: '2026-10-11' }, 'b'.repeat(64), '2026-10-12T08:00:00Z'), cls: 'ingest' });
  const old = payload([R('S2', '1002', 'AS-T-1')], { from: '2026-08-03', to: '2026-09-27' }, 'c'.repeat(64), '2026-09-28T08:00:00Z');
  await call(env, 'POST', '/v1/collect/aps-map', { body: old, cls: 'ingest' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM aps_map_version').get().n, 3, 'every version kept');
  assert.equal(db.prepare("SELECT status FROM aps_map_active WHERE order_key = '1002'").get().status, 'mixed_shipment');
  // Financial results, catalogs, revisions and runs untouched.
  assert.deepEqual(tableCounts(env), before);
  // Reader: published week only.
  const rd = await call(env, 'GET', '/v1/aps/2026-09-21', { cls: 'reader' });
  assert.equal(rd.status, 200);
  assert.deepEqual(rd.json.orders.map(o => [o.orderKey, o.status]).sort(), [['1001', 'aps_only'], ['1002', 'mixed_shipment']]);
  assert.equal(rd.json.versions.length, 3);
  assert.equal((await call(env, 'GET', '/v1/aps/2026-09-28', { cls: 'reader' })).status, 404, 'held week');
  assert.equal((await call(env, 'GET', '/v1/aps/2026-09-21')).status, 401, 'no credential');
  // Collector coverage (backfill decision).
  const cov = await call(env, 'GET', '/v1/collect/aps-map/coverage', { cls: 'ingest' });
  assert.deepEqual(cov.json, { coveredFrom: '2026-08-03', coveredTo: '2026-10-11', versions: 3 });
  // Validation: unknown status, bad cost, missing source hash.
  const bad = structuredClone(p1); bad.orders[0].status = 'guess';
  assert.equal((await call(env, 'POST', '/v1/collect/aps-map', { body: bad, cls: 'ingest' })).status, 400);
  const bad2 = structuredClone(p1); bad2.orders[0].apsCostCents = 500;
  assert.equal((await call(env, 'POST', '/v1/collect/aps-map', { body: bad2, cls: 'ingest' })).status, 400, 'aps_only carries no cost');
  // Writes for one 2-order export: version + 2 order rows + 2 current rows (+ the usage meter).
  assert.ok(writes1 <= 12, `writes ${writes1}`);
});

const many = (n, status = 'aps_only', prefix = 5000) => Array.from({ length: n }, (_, i) => ({ orderKey: String(prefix + i), status, apsCostCents: null, scrOrderCents: null,
  firstShipDate: '2026-09-22', lastShipDate: '2026-09-22', apsShipments: 1, otherShipments: 0, mixedShipments: status === 'mixed_shipment' ? 1 : 0, noItemShipments: 0, apsUnits: 1, scrCheck: 'checked' }));
const metaOf = (n, exportedAt, sha = 'd') => ({ schemaVersion: 'aps_map.v1', window: { from: '2026-08-10', to: '2026-10-04' }, source: { sanitizedSha256: sha.repeat(64), exportedAt },
  rows: n, duplicateRows: 0, shipments: n, voidedShipments: 0, byStatus: {}, scrRowsAvailable: false });
const published = db => db.prepare(`INSERT INTO snapshot (snapshot_id, week_start, revision, status, computed_at, engine_version, policy, profitability_status, storage)
  VALUES ('snp_20260921000000000000', '2026-09-21', 1, 'published', 'x', 'e', '{}', 'p', 'chunked')`).run();

test('APS mapping: an interrupted upload stays pending, is never applied, and the same export resumes it', async () => {
  const env = await makeEnv({ DASHBOARD_READER_SECRET: 'r'.repeat(40) });
  const db = env.DB.db; published(db);
  const body = { meta: metaOf(60, '2026-10-05T08:00:00Z'), orders: many(60) };
  // The second D1 batch fails once (60 orders = 2 batches of rows).
  const realBatch = env.DB.batch.bind(env.DB); let calls = 0;
  env.DB.batch = async st => { if (++calls === 2) throw new Error('D1 batch failed'); return realBatch(st); };
  const r1 = await call(env, 'POST', '/v1/collect/aps-map', { body, cls: 'ingest' });
  assert.ok(r1.status >= 500, `interrupted: ${r1.status}`);
  assert.equal(db.prepare("SELECT status FROM aps_map_version").get().status, 'pending');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM aps_map_order').get().n, 50);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM aps_map_active').get().n, 0, 'nothing applied from a pending version');
  assert.equal((await call(env, 'GET', '/v1/collect/aps-map/coverage', { cls: 'ingest' })).json.versions, 0, 'a pending version covers nothing');
  assert.equal((await call(env, 'GET', '/v1/aps/2026-09-21', { cls: 'reader' })).json.orders.length, 0);
  // The collector sends the same export again: resumed, completed, applied.
  const r2 = await call(env, 'POST', '/v1/collect/aps-map', { body, cls: 'ingest' });
  assert.deepEqual([r2.status, r2.json.sourceStatus], [200, 'source_resumed']);
  assert.equal(db.prepare("SELECT status FROM aps_map_version").get().status, 'complete');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM aps_map_active').get().n, 60);
  assert.equal((await call(env, 'GET', '/v1/aps/2026-09-21', { cls: 'reader' })).json.orders.length, 60);
});

test('APS mapping: content seen before but exported later is re-applied (APS-only → mixed → APS-only)', async () => {
  const env = await makeEnv({ DASHBOARD_READER_SECRET: 'r'.repeat(40) });
  const db = env.DB.db; published(db);
  const A = many(3, 'aps_only'), B = many(3, 'mixed_shipment');
  const up = async (orders, at, sha) => (await call(env, 'POST', '/v1/collect/aps-map', { body: { meta: metaOf(3, at, sha), orders }, cls: 'ingest' })).json;
  assert.equal((await up(A, '2026-10-05T08:00:00Z', 'a')).sourceStatus, 'source_received');
  assert.equal((await up(B, '2026-10-12T08:00:00Z', 'b')).sourceStatus, 'source_received');
  const again = await up(A, '2026-10-19T08:00:00Z', 'c');
  assert.deepEqual([again.sourceStatus, again.reapplied], ['source_no_change', true]);
  assert.deepEqual(db.prepare('SELECT DISTINCT status FROM aps_map_active').all().map(r => r.status), ['aps_only'], 'the newest export decides');
  assert.equal(db.prepare("SELECT times_received FROM aps_map_version WHERE content_sha256 IS NOT NULL ORDER BY received_at LIMIT 1").get().times_received, 2);
  // A late retry of an OLDER export (A at its first export time) never replaces a newer classification.
  await up(B, '2026-10-26T08:00:00Z', 'b');
  await up(A, '2026-10-05T08:00:00Z', 'a');
  assert.deepEqual(db.prepare('SELECT DISTINCT status FROM aps_map_active').all().map(r => r.status), ['mixed_shipment']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM aps_map_version').get().n, 2, 'versions are by content; every receipt is counted');
});

test('APS mapping: split pins are stored and refused when malformed', async () => {
  const env = await makeEnv({ DASHBOARD_READER_SECRET: 'r'.repeat(40) });
  const db = env.DB.db; published(db);
  const pins = [['2026-09-22', 1, 640, 1, 640, null], ['2026-09-23', 1, 910, 0, 0, null]];
  const o = { ...many(1)[0], status: 'split_matched', apsCostCents: 640, scrOrderCents: 1550, otherShipments: 1, scrPins: pins };
  const meta = { ...metaOf(1, '2026-10-05T08:00:00Z'), scrRowsAvailable: true, scrSource: { sanitizedSha256: 'f'.repeat(64), from: '2026-08-10', to: '2026-10-04' } };
  assert.equal((await call(env, 'POST', '/v1/collect/aps-map', { body: { meta, orders: [o] }, cls: 'ingest' })).status, 200);
  assert.deepEqual({ ...db.prepare('SELECT scr_sha256, scr_from, scr_to FROM aps_map_version').get() }, { scr_sha256: 'f'.repeat(64), scr_from: '2026-08-10', scr_to: '2026-10-04' });
  assert.deepEqual(JSON.parse(db.prepare('SELECT scr_pins FROM aps_map_active').get().scr_pins), pins);
  const both = [['2026-09-25', 2, 1500, 1, 800, 'scr_' + 'a'.repeat(20)]];
  for (const bad of [{ ...o, scrPins: null }, { ...o, scrOrderCents: 600 }, { ...many(1)[0], scrOrderCents: 100 }, { ...many(1)[0], scrPins: pins },
    { ...o, scrPins: [pins[0], [...pins[1].slice(0, 2), 900, 0, 0, null]] },                        // pins do not add up to the order total
    { ...o, scrPins: [pins[1], pins[0]] },                                                           // dates out of order
    { ...o, apsCostCents: 800, scrOrderCents: 1500, scrPins: [[...both[0].slice(0, 5), null]] },     // a date with both kinds needs its row version
    { ...o, scrPins: [[...pins[0].slice(0, 5), 'scr_' + 'b'.repeat(20)], pins[1]] }])                 // a one-kind date carries none
    assert.equal((await call(env, 'POST', '/v1/collect/aps-map', { body: { meta: metaOf(1, 'x', 'e'), orders: [bad] }, cls: 'ingest' })).status, 400, JSON.stringify(bad.scrPins));
});

// A collector-computed published snapshot: its manifest pins each ship date to [date, owning version, day hash, kept?],
// and the stored days hold the order groups [orderKey, cents, rows] the snapshot accepted.
const VA = 'scr_' + 'a'.repeat(20), VB = 'scr_' + 'b'.repeat(20), VK = 'scr_' + 'c'.repeat(20);
function publishWithRows(db, { storage = 'chunked', days, orders }) {
  db.prepare(`INSERT INTO snapshot (snapshot_id, week_start, revision, status, computed_at, engine_version, policy, profitability_status, storage)
    VALUES ('snp_20260921000000000000', '2026-09-21', 2, 'published', 'x', 'e', '{}', 'p', ?)`).run(storage);
  for (const d of days) {
    db.prepare(`INSERT INTO scr_day (version_id, ship_date, day_hash, cost_cents, row_count, groups, outcome) VALUES (?, ?, ?, 0, 0, ?, 'new')`).run(d.v, d.date, d.h, JSON.stringify(d.groups));
    for (const g of d.groups) db.prepare('INSERT INTO scr_day_key (order_key, version_id, ship_date) VALUES (?, ?, ?)').run(g[0], d.v, d.date);
  }
  const manifest = { orders: orders.map(n => [`#${n}`, 'h', 'src']), scrDays: days.map(d => (d.kept ? [d.date, d.v, d.h, d.kept] : [d.date, d.v, d.h])) };
  db.prepare(`INSERT INTO result_upload (snapshot_id, week_start, manifest_hash, engine_version, idx, manifest, status, created_at)
    VALUES ('snp_20260921000000000000', '2026-09-21', 'm', 'e', '{}', ?, 'finalized', 'x')`).run(JSON.stringify(manifest));
}
const split = (key, pins, first = pins[0][0]) => ({ ...many(1, 'aps_only', Number(key))[0], status: 'split_matched', otherShipments: 1, firstShipDate: first, lastShipDate: pins[pins.length - 1][0],
  scrPins: pins, apsCostCents: pins.reduce((t, p) => t + p[4], 0), scrOrderCents: pins.reduce((t, p) => t + p[2], 0) });
const checks = async (env, orders) => {
  assert.equal((await call(env, 'POST', '/v1/collect/aps-map', { body: { meta: metaOf(orders.length, '2026-10-05T08:00:00Z'), orders }, cls: 'ingest' })).status, 200);
  const rd = (await call(env, 'GET', '/v1/aps/2026-09-21', { cls: 'reader' })).json;
  return { rd, by: Object.fromEntries(rd.orders.map(o => [o.orderKey, o.snapshotCheck || null])) };
};

test('APS split costs are checked against the exact rows the published snapshot accepted, not their total', async () => {
  const env = await makeEnv({ DASHBOARD_READER_SECRET: 'r'.repeat(40) });
  const db = env.DB.db;
  publishWithRows(db, { orders: ['4001', '4002', '4003', '4004', '4005', '4006'], days: [
    { date: '2026-09-22', v: VA, h: 'h22', groups: [['4001', 640, 1], ['4002', 640, 1], ['4005', 300, 1]] },
    { date: '2026-09-23', v: VA, h: 'h23', groups: [['4001', 910, 1], ['4002', 910, 1]] },
    { date: '2026-09-25', v: VB, h: 'h25', groups: [['4003', 1500, 2], ['4006', 1200, 2]], kept: [['4006', VK]] },
    { date: '2026-09-26', v: VA, h: 'h26', groups: [['4004', 1500, 2]] },
  ] });
  // An older version's day for the same order and date, not pinned by the snapshot: ignored.
  db.prepare(`INSERT INTO scr_day (version_id, ship_date, day_hash, cost_cents, row_count, groups, outcome) VALUES (?, '2026-09-22', 'old', 0, 0, '[["4001",999,1]]', 'new')`).run(VK);
  db.prepare('INSERT INTO scr_day_key (order_key, version_id, ship_date) VALUES (?, ?, ?)').run('4001', VK, '2026-09-22');
  const { rd, by } = await checks(env, [
    split('4001', [['2026-09-22', 1, 640, 1, 640, null], ['2026-09-23', 1, 910, 0, 0, null]]),        // the accepted rows
    // REGRESSION: the APS and other labels' costs changed ($6.40/$9.10 → $8.50/$7.00) but the order total ($15.50) did not.
    split('4002', [['2026-09-22', 1, 850, 1, 850, null], ['2026-09-23', 1, 700, 0, 0, null]]),
    split('4003', [['2026-09-25', 2, 1500, 1, 800, VB]]),                                                // one date, split from the pinned version's rows
    split('4004', [['2026-09-26', 2, 1500, 1, 800, VB]]),                                                // split from ANOTHER report's rows, same total
    split('4005', [['2026-09-22', 1, 300, 1, 300, null], ['2026-09-29', 1, 500, 0, 0, null]]),          // a label the snapshot never accepted
    split('4006', [['2026-09-25', 2, 1200, 1, 500, VK]]),                                                // a cost the date kept from an earlier report
    split('4007', [['2026-09-22', 1, 640, 1, 640, null], ['2026-09-23', 1, 910, 0, 0, null]]),        // another week's order
  ]);
  assert.deepEqual(rd.snapshot, { snapshotId: 'snp_20260921000000000000', revision: 2 }, 'the snapshot the check used');
  assert.deepEqual(by['4001'], { status: 'verified' });
  assert.deepEqual(by['4002'], { status: 'unverified', reason: 'rows_differ' }, 'a matching total is not enough');
  assert.deepEqual(by['4003'], { status: 'verified' });
  assert.deepEqual(by['4004'], { status: 'unverified', reason: 'rows_from_another_report' });
  assert.deepEqual(by['4005'], { status: 'unverified', reason: 'ship_dates_differ' });
  assert.deepEqual(by['4006'], { status: 'verified' });
  assert.deepEqual(by['4007'], { status: 'other_week' });
  assert.deepEqual(rd.orders.find(o => o.orderKey === '4002').scrPins, [['2026-09-22', 1, 850, 1, 850, null], ['2026-09-23', 1, 700, 0, 0, null]], 'pins retained through the reader route');
});

test('APS split costs: a published snapshot without pinned rows verifies nothing', async () => {
  const env = await makeEnv({ DASHBOARD_READER_SECRET: 'r'.repeat(40) });
  publishWithRows(env.DB.db, { storage: 'rows', orders: ['4001'], days: [{ date: '2026-09-22', v: VA, h: 'h', groups: [['4001', 640, 1]] }] });
  const { by } = await checks(env, [split('4001', [['2026-09-22', 1, 640, 1, 640, null]])]);
  assert.deepEqual(by['4001'], { status: 'unverified', reason: 'snapshot_rows_not_pinned' });
});

test('APS mapping: the version records which saved format the export came from', async () => {
  const env = await makeEnv({ DASHBOARD_READER_SECRET: 'r'.repeat(40) });
  const db = env.DB.db;
  const up = async (template, sha) => (await call(env, 'POST', '/v1/collect/aps-map', { body: { meta: { ...metaOf(1, '2026-10-05T08:00:00Z', sha), source: { sanitizedSha256: sha.repeat(64), exportedAt: 'x', template } }, orders: many(1, 'aps_only', 6000 + sha.charCodeAt(0)) }, cls: 'ingest' })).status;
  assert.equal(await up('SB GP APS mapping', 'a'), 200);
  assert.equal(await up('SB GP APS mapping v2', 'b'), 200);
  assert.equal(await up('something else', 'c'), 200);
  assert.deepEqual(db.prepare('SELECT template FROM aps_map_version ORDER BY sanitized_sha256').all().map(r => r.template), ['SB GP APS mapping', 'SB GP APS mapping v2', 'SB GP APS mapping v2']);
});
