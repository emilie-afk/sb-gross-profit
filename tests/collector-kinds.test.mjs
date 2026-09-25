/**
 * Collector export roles (C2): the Shipping Cost Report is sanitized on the
 * collector and delivered to its own endpoint; the mapping export keeps its
 * exact-template rule. In-process Worker, synthetic rows only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/src/index.js';
import { makeEnv } from '../worker/test/helpers.mjs';
import { toCsvText } from '../shared/adapters/shopifyCsv.js';
import { prepareExport, reportWindow, KINDS } from '../automation/shipstation-export/src/kinds.mjs';
import { uploadToWorker } from '../automation/shipstation-export/src/upload.mjs';
import { reportRow, multiRowOrder } from './fixtures-shipping-cost.mjs';
import { ssCustom, ssTemplate } from './fixtures-normalized.mjs';

const week = { weekStart: '2026-09-14', weekEnd: '2026-09-20' };
const rawReport = () => { const rows = [reportRow({ date: '2026-09-15', order: '930001' }), ...multiRowOrder('930002', '2026-09-16', ['5.10', '5.10'])]; return toCsvText(rows, Object.keys(rows[0])); };
const viaWorker = env => async (url, init) => worker.fetch(new Request(url, init), env);

test('the report window is the eight weeks ending on the reporting Sunday', () => {
  assert.deepEqual(reportWindow(week), { from: '2026-07-27', to: '2026-09-20', fromUS: '07/27/2026', toUS: '09/20/2026' });
});

test('the Shipping Cost Report is sanitized before upload: no Recipient, Shipping Paid or +/-', () => {
  const p = prepareExport('shipstation_shipping_cost_report', rawReport(), { week, exportedAt: '2026-09-21T08:06:00Z' });
  assert.ok(!p.refused);
  assert.equal(p.path, KINDS.shipstation_shipping_cost_report.path);
  for (const bad of ['Recipient', 'SYNTHETIC RECIPIENT', 'Shipping Paid', '+/-']) assert.ok(!p.payload.text.includes(bad), bad);
  assert.deepEqual([p.facts.rowCount, p.facts.shippingCostTotal], [3, 16.45]);
  assert.notEqual(p.facts.rawSha256, p.facts.sanitizedSha256, 'the raw hash stays local; the sanitized hash is uploaded');
  assert.ok(!('rawSha256' in p.payload));
});

test('a report whose layout changed is refused on the collector', () => {
  const rows = [reportRow({ extra: { 'Ship To - Email': 'synthetic@example.invalid' } })];
  const p = prepareExport('shipstation_shipping_cost_report', toCsvText(rows, Object.keys(rows[0])), { week, exportedAt: '2026-09-21T08:06:00Z' });
  assert.equal(p.refused, 'report_schema_changed');
});

test('the mapping export keeps its exact-template rule', () => {
  const bad = ssCustom({ shipment: 'M1', order: '930003', fee: '5' });
  assert.equal(prepareExport('shipstation_mapping_export', toCsvText(bad, Object.keys(bad[0])), { week }).refused, 'refused_customer_columns');
  const ok = ssTemplate({ shipment: 'M1', order: '930003', fee: '5' });
  assert.ok(!prepareExport('shipstation_mapping_export', toCsvText(ok, Object.keys(ok[0])), { week }).refused);
});

test('end to end: prepared report → Worker version; re-sending is source_no_change', async () => {
  const env = await makeEnv();
  const p = prepareExport('shipstation_shipping_cost_report', rawReport(), { week, exportedAt: '2026-09-21T08:06:00Z' });
  const a = await uploadToWorker({ workerUrl: 'https://worker.example', ingestSecret: env.INGEST_SECRET, path: p.path, payload: p.payload, fetchImpl: viaWorker(env), sleep: async () => {} });
  assert.deepEqual([a.ok, a.sourceStatus, a.status], [true, 'source_received', 'pending_review']);
  const b = await uploadToWorker({ workerUrl: 'https://worker.example', ingestSecret: env.INGEST_SECRET, path: p.path, payload: p.payload, fetchImpl: viaWorker(env), sleep: async () => {} });
  assert.deepEqual([b.ok, b.sourceStatus, b.versionId], [true, 'source_no_change', a.versionId]);
  const rows = (await env.DB.prepare('SELECT COUNT(*) n, SUM(shipping_cost_cents) c FROM shipping_cost_row').first());
  assert.deepEqual([rows.n, rows.c], [3, 1645]);
});

test('C5: the mapping export is dormant unless re-enabled explicitly', async () => {
  const { assertKindEnabled } = await import('../automation/shipstation-export/src/kinds.mjs');
  assert.equal(assertKindEnabled('shipstation_shipping_cost_report', {}), true);
  assert.throws(() => assertKindEnabled('shipstation_mapping_export', {}), e => e.code === 'mapping_export_dormant');
  assert.throws(() => assertKindEnabled('shipstation_mapping_export', { kinds: { shipstation_mapping_export: { enabled: 'yes' } } }), e => e.code === 'mapping_export_dormant');
  assert.equal(assertKindEnabled('shipstation_mapping_export', { kinds: { shipstation_mapping_export: { enabled: true } } }), true);
  assert.throws(() => assertKindEnabled('nope', {}), /Unknown export kind/);
});
