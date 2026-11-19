/**
 * ShipStation Windows job → Worker delivery (automation/shipstation-export/src/upload.mjs).
 * Runs the real Worker in-process on the D1 stand-in; synthetic shipments only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import worker from '../worker/src/index.js';
import { makeEnv, WEEK } from '../worker/test/helpers.mjs';
import { ssCustom, ssTemplate } from './fixtures-normalized.mjs';
import { toCsvText } from '../shared/adapters/shopifyCsv.js';
import { uploadShipStationCsv, workerEndpoint } from '../automation/shipstation-export/src/upload.mjs';
import { invalidExportReason, purgeOlderThan, assertNoSecretsInConfig } from '../automation/shipstation-export/src/lib.mjs';

const text = () => {
  const rows = ssTemplate({ shipment: 'SU1', order: '920001', fee: '5.25', items: [{ sku: 'MG-ALOE', qty: 1 }] });
  return toCsvText(rows, Object.keys(rows[0]));
};
const viaWorker = (env, { failFirst = 0, status = 503 } = {}) => {
  let n = 0;
  const fn = async (url, init) => {
    n++;
    if (n <= failFirst) return status === 'network' ? Promise.reject(new Error('ECONNRESET')) : new Response('{}', { status });
    return worker.fetch(new Request(url.replace('https://worker.example', 'https://worker.example'), init), env);
  };
  fn.calls = () => n;
  return fn;
};
const noSleep = async () => {};

test('only https Worker URLs are accepted', () => {
  assert.equal(workerEndpoint('https://w.example/anything'), 'https://w.example/v1/ingest/shipstation');
  assert.throws(() => workerEndpoint('http://w.example'));
  assert.throws(() => workerEndpoint('not a url'));
});

test('upload succeeds, and a retried identical upload is source_no_change without duplicate shipments', async () => {
  const env = await makeEnv();
  const t = text();
  const a = await uploadShipStationCsv({ workerUrl: 'https://worker.example', ingestSecret: env.INGEST_SECRET, weekStart: WEEK, text: t,
    exportedAt: '2026-09-21T08:06:00Z', fetchImpl: viaWorker(env), sleep: noSleep });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.sourceStatus, 'source_received');
  assert.equal(a.sourceHash, a.sanitizedSha256);
  const b = await uploadShipStationCsv({ workerUrl: 'https://worker.example', ingestSecret: env.INGEST_SECRET, weekStart: WEEK, text: t,
    fetchImpl: viaWorker(env), sleep: noSleep });
  assert.deepEqual([b.ok, b.sourceStatus, b.rowsWritten], [true, 'source_no_change', 0]);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM shipment').first()).n, 1);
});

test('5xx and network errors are retried; the eventual success writes once', async () => {
  const env = await makeEnv();
  const f = viaWorker(env, { failFirst: 2, status: 'network' });
  const r = await uploadShipStationCsv({ workerUrl: 'https://worker.example', ingestSecret: env.INGEST_SECRET, weekStart: WEEK, text: text(), fetchImpl: f, sleep: noSleep });
  assert.deepEqual([r.ok, r.attempts, f.calls()], [true, 3, 3]);
  const g = viaWorker(env, { failFirst: 1, status: 503 });
  const r2 = await uploadShipStationCsv({ workerUrl: 'https://worker.example', ingestSecret: env.INGEST_SECRET, weekStart: WEEK, text: text(), fetchImpl: g, sleep: noSleep });
  assert.deepEqual([r2.ok, r2.sourceStatus], [true, 'source_no_change']);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM shipment').first()).n, 1);
});

test('a permanent 4xx is not retried (wrong secret, customer columns)', async () => {
  const env = await makeEnv();
  const f = viaWorker(env);
  const r = await uploadShipStationCsv({ workerUrl: 'https://worker.example', ingestSecret: 'wrong', weekStart: WEEK, text: text(), fetchImpl: f, sleep: noSleep });
  assert.equal(r.ok, false);
  assert.equal(f.calls(), 1);
  const rows = ssCustom({ shipment: 'SU2', order: '920002', fee: '5' });          // still has Recipient
  const g = viaWorker(env);
  const r2 = await uploadShipStationCsv({ workerUrl: 'https://worker.example', ingestSecret: env.INGEST_SECRET, weekStart: WEEK,
    text: toCsvText(rows, Object.keys(rows[0])), fetchImpl: g, sleep: noSleep });
  assert.deepEqual([r2.ok, r2.httpStatus, r2.error, g.calls()], [false, 400, 'customer_data_rejected', 1]);
});

test('retries stop after the attempt limit', async () => {
  let n = 0;
  const r = await uploadShipStationCsv({ workerUrl: 'https://worker.example', ingestSecret: 'x', weekStart: WEEK, text: 'a\n1\n',
    fetchImpl: async () => { n++; return new Response('{}', { status: 502 }); }, attempts: 3, sleep: noSleep });
  assert.deepEqual([r.ok, r.error, n], [false, 'http_502', 3]);
});

test('an invalid export is detected before upload', () => {
  assert.match(invalidExportReason(['Order Number', 'Item SKU', 'Carrier Fee'], 3), /Shipment ID/);
  assert.match(invalidExportReason(['Shipment ID', 'Order Number', 'Item SKU'], 3), /Carrier Fee and Rate/);
  assert.equal(invalidExportReason(['Shipment ID', 'Order Number', 'Item SKU', 'Rate'], 0), 'no shipment rows');
  assert.equal(invalidExportReason(['Shipment ID', 'Order Number', 'Item SKU', 'Carrier Fee'], 5), null);
});

test('quarantine purge removes only files older than the retention window', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssq-'));
  const old = path.join(dir, 'old.csv'), fresh = path.join(dir, 'fresh.csv');
  fs.writeFileSync(old, 'x'); fs.writeFileSync(fresh, 'y');
  const t = Date.now() / 1000 - 73 * 3600; fs.utimesSync(old, t, t);
  assert.equal(purgeOlderThan(dir, 72 * 3600_000), 1);
  assert.deepEqual(fs.readdirSync(dir), ['fresh.csv']);
  fs.rmSync(dir, { recursive: true });
});

test('the config may name credential targets but may not hold a secret', () => {
  assert.doesNotThrow(() => assertNoSecretsInConfig({ ingestCredentialTarget: 'sb-gp-ingest', workerUrl: 'https://w.example' }));
  assert.throws(() => assertNoSecretsInConfig({ ingest: { secret: 'abc' } }));
});
