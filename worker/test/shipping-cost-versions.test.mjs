/**
 * Shipping Cost Report immutable versions and non-overlapping active segments (C2).
 * Synthetic reports only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, ingest, admin } from './helpers.mjs';
import { sanitizeShippingCostReport, parseShippingCostReport } from '../../shared/adapters/shippingCostReport.js';
import { toCsvText } from '../../shared/adapters/shopifyCsv.js';
import { replaceRange, contiguous } from '../src/shippingCost.js';
import { reportRow, rollingRows } from '../../tests/fixtures-shipping-cost.mjs';

const body = (rawRows, from, to, { exportedAt = null, tamper = null } = {}) => {
  const s = sanitizeShippingCostReport(rawRows);
  const rows = tamper ? tamper(s.rows) : s.rows;
  const p = parseShippingCostReport(s.rows, { requestedFrom: from, requestedTo: to });
  return { format: 'csv_text', text: toCsvText(rows, Object.keys(rows[0])), requestedFrom: from, requestedTo: to,
           rowCount: p.rowCount, shippingCostTotal: p.shippingCostCents / 100, exportedAt: exportedAt || after(to) };
};
// Exported the day after the requested range ends (the collector's normal case).
const after = to => { const d = new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return `${d.toISOString().slice(0, 10)}T15:00:00Z`; };
const post = (env, b) => ingest(env, '/v1/ingest/shipping-cost-report', b);
const accept = (env, id) => admin(env, 'POST', `/v1/admin/shipping-cost/versions/${id}/accept`, { reason: 'reviewed (test)' });
const effective = async env => (await admin(env, 'GET', '/v1/admin/shipping-cost/effective')).json;
const sumCents = rows => rows.reduce((s, r) => s + Math.round(Number(r['Shipping Cost']) * 100), 0);

async function baseline(env, from = '2026-07-06', to = '2026-08-30') {
  const r = await post(env, body(rollingRows(from, to), from, to, { exportedAt: after(to) }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.status, 'pending_review', 'the first version always needs an admin');
  assert.equal((await accept(env, r.json.versionId)).status, 200);
  return r.json.versionId;
}

test('pure segment arithmetic: replacing a range keeps earlier dates and stays contiguous', () => {
  const s = replaceRange([{ segFrom: '2026-07-06', segTo: '2026-08-30', versionId: 'A', activationId: 'a1' }], '2026-07-13', '2026-09-06', 'B', 'b1');
  assert.deepEqual(s.map(x => [x.segFrom, x.segTo, x.versionId]), [['2026-07-06', '2026-07-12', 'A'], ['2026-07-13', '2026-09-06', 'B']]);
  assert.ok(contiguous(s));
  assert.ok(!contiguous([{ segFrom: '2026-07-01', segTo: '2026-07-05' }, { segFrom: '2026-07-08', segTo: '2026-07-09' }]));
});

test('two rolling 8-week reports shifted by 7 days: no double counting, earliest dates kept, trailing dates activated', async () => {
  const env = await makeEnv();
  const a = await baseline(env);
  const bRows = rollingRows('2026-07-13', '2026-09-06');
  const r = await post(env, body(bRows, '2026-07-13', '2026-09-06', { exportedAt: after('2026-09-06') }));
  assert.equal(r.json.status, 'accepted', JSON.stringify(r.json.comparison));
  assert.ok(r.json.comparison.identical);
  const seg = (await admin(env, 'GET', '/v1/admin/shipping-cost/segments')).json.segments;
  assert.deepEqual(seg.map(s => [s.segFrom, s.segTo, s.versionId]), [['2026-07-06', '2026-07-12', a], ['2026-07-13', '2026-09-06', r.json.versionId]]);
  const expected = sumCents(rollingRows('2026-07-06', '2026-09-06'));           // every weekday counted exactly once
  const eff = await effective(env);
  assert.equal(Math.round(eff.shippingCostTotal * 100), expected);
  assert.equal(eff.rows, rollingRows('2026-07-06', '2026-09-06').length);
});

test('rollback reconstructs the exact previous active segments', async () => {
  const env = await makeEnv();
  const a = await baseline(env);
  const before = (await admin(env, 'GET', '/v1/admin/shipping-cost/segments')).json.segments;
  const r = await post(env, body(rollingRows('2026-07-13', '2026-09-06'), '2026-07-13', '2026-09-06', { exportedAt: after('2026-09-06') }));
  assert.equal(r.json.status, 'accepted');
  const rb = await admin(env, 'POST', `/v1/admin/shipping-cost/activations/${r.json.activationId}/rollback`, { reason: 'test rollback' });
  assert.equal(rb.status, 200, JSON.stringify(rb.json));
  assert.deepEqual((await admin(env, 'GET', '/v1/admin/shipping-cost/segments')).json.segments, before);
  assert.equal(before[0].versionId, a);
});

test('weekend dates with zero rows are not missing exports', async () => {
  const env = await makeEnv();
  await baseline(env, '2026-08-03', '2026-08-16');                               // two weeks, weekends empty
  const r = await post(env, body(rollingRows('2026-08-10', '2026-08-23'), '2026-08-10', '2026-08-23', { exportedAt: after('2026-08-23') }));
  assert.equal(r.json.status, 'accepted', JSON.stringify(r.json.comparison));
  assert.equal(r.json.comparison.datesLostRows, 0);
});

test('a truncated report can never delete accepted expense: it waits for review and changes nothing', async () => {
  const env = await makeEnv();
  await baseline(env);
  const before = await effective(env);
  const truncated = rollingRows('2026-07-13', '2026-09-06').filter(r => !r['Ship Date'].startsWith('8/2'));   // Aug 20–29 missing
  const r = await post(env, body(truncated, '2026-07-13', '2026-09-06', { exportedAt: after('2026-09-06') }));
  assert.equal(r.json.status, 'pending_review');
  assert.ok(r.json.comparison.disappeared > 0 && r.json.comparison.datesLostRows > 0);
  assert.deepEqual(await effective(env), before);
});

test('a changed order total in the overlap needs review; an admin may accept it with a reason', async () => {
  const env = await makeEnv();
  await baseline(env);
  const rows = rollingRows('2026-07-13', '2026-09-06').map((r, i) => (i === 3 ? { ...r, 'Shipping Cost': '99.00', '+/-': '0' } : r));
  const r = await post(env, body(rows, '2026-07-13', '2026-09-06', { exportedAt: after('2026-09-06') }));
  assert.equal(r.json.status, 'pending_review');
  assert.equal(r.json.comparison.changed, 1);
  assert.equal((await admin(env, 'POST', `/v1/admin/shipping-cost/versions/${r.json.versionId}/accept`, {})).status, 400, 'reason required');
  assert.equal((await accept(env, r.json.versionId)).status, 200);
});

test('a gap between segments cannot be activated', async () => {
  const env = await makeEnv();
  await baseline(env, '2026-07-06', '2026-07-19');
  const r = await post(env, body(rollingRows('2026-08-03', '2026-08-16'), '2026-08-03', '2026-08-16', { exportedAt: after('2026-08-16') }));
  assert.equal(r.json.status, 'pending_review');
  assert.ok(r.json.comparison.gap);
  const a = await accept(env, r.json.versionId);
  assert.deepEqual([a.status, a.json.error], [409, 'segment_gap']);
});

test('an export taken on the last requested day is flagged as a possibly incomplete trailing date', async () => {
  const env = await makeEnv();
  await baseline(env);
  const r = await post(env, body(rollingRows('2026-07-13', '2026-09-06'), '2026-07-13', '2026-09-06', { exportedAt: '2026-09-06T20:00:00Z' }));
  assert.equal(r.json.status, 'pending_review');
  assert.ok(r.json.comparison.possibleIncompleteTrailingDate);
});

test('duplicate upload is source_no_change; Recipient, Shipping Paid or +/- in the upload are rejected; manifest must match', async () => {
  const env = await makeEnv();
  const b = body([reportRow({ date: '2026-08-10' })], '2026-08-10', '2026-08-14', { exportedAt: after('2026-08-14') });
  const first = await post(env, b);
  assert.equal(first.json.sourceStatus, 'source_received');
  const again = await post(env, b);
  assert.deepEqual([again.status, again.json.sourceStatus, again.json.versionId], [200, 'source_no_change', first.json.versionId]);
  for (const col of ['Recipient', 'Shipping Paid', '+/-']) {
    const bad = body([reportRow({ date: '2026-08-11' })], '2026-08-10', '2026-08-14', { tamper: rows => rows.map(r => ({ ...r, [col]: 'X' })) });
    const r = await post(env, bad);
    assert.deepEqual([r.status, r.json.error], [400, 'customer_data_rejected'], col);
    assert.ok(!JSON.stringify(r.json).includes('SYNTHETIC RECIPIENT'));
  }
  const wrong = { ...body([reportRow({ date: '2026-08-12' })], '2026-08-10', '2026-08-14'), shippingCostTotal: 1.23 };
  assert.deepEqual([(await post(env, wrong)).status, (await post(env, wrong)).json.error], [400, 'report_invalid']);
  const versions = (await admin(env, 'GET', '/v1/admin/shipping-cost/versions')).json.versions;
  assert.equal(versions.length, 1, 'rejected uploads create no version');
});

test('report currency, time zone and store are audited settings; changing one clears source verification', async () => {
  const env = await makeEnv();
  const s = (await admin(env, 'GET', '/v1/admin/settings')).json.settings;
  assert.deepEqual([s.shipping_report_currency, s.shipping_report_timezone, s.shipping_cost_report_source_verified], ['USD', 'America/Los_Angeles', false]);
  assert.equal((await admin(env, 'POST', '/v1/admin/settings', { shipping_cost_report_source_verified: true, reason: 'try (test)' })).status, 400);
  assert.equal((await admin(env, 'POST', '/v1/admin/settings', { shipping_report_timezone: 'America/Denver' })).status, 400, 'reason required');
  assert.equal((await admin(env, 'POST', '/v1/admin/settings', { shipping_report_timezone: 'America/Denver', reason: 'test change' })).status, 200);
  const audit = (await env.DB.prepare("SELECT key, reason FROM settings_audit WHERE key LIKE 'shipping_%' ORDER BY id").all()).results;
  assert.ok(audit.some(a => a.key === 'shipping_report_currency' && /no currency field/.test(a.reason)), 'migration records the operator confirmation');
  assert.ok(audit.some(a => a.key === 'shipping_cost_report_source_verified' && /automatic/.test(a.reason || '')));
});
