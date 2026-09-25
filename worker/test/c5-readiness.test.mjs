/**
 * C5 readiness: the week needs the Shopify export, the updated-order scan, a
 * Shipping Cost Report received for the week, the catalog refresh, and a closed
 * reporting period. The dormant ShipStation mapping export never satisfies
 * shipping readiness. Synthetic data only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loaded, ingest, admin, viaNormalized, WEEK } from './helpers.mjs';
import { readiness } from '../src/compute.js';
import { getSettings } from '../src/db.js';
import { reportRow } from '../../tests/fixtures-shipping-cost.mjs';
import { sanitizeShippingCostReport, parseShippingCostReport } from '../../shared/adapters/shippingCostReport.js';
import { toCsvText } from '../../shared/adapters/shopifyCsv.js';
import { ssCustom } from '../../tests/fixtures-normalized.mjs';

const ready = async env => (await admin(env, 'GET', `/v1/admin/readiness?weekStart=${WEEK}`)).json;
const updatesScan = env => ingest(env, '/v1/ingest/shopify', viaNormalized({ mode: 'updated_since', nodes: [], weekStart: WEEK }));

/** Ingest a report WITHOUT accepting it (the first version always waits for review). */
async function sendReport(env, { from = WEEK, to = '2026-09-20', rows = [{ order: '900001', date: '2026-09-15', cost: '5.10' }] } = {}) {
  const s = sanitizeShippingCostReport(rows.map(r => reportRow({ ...r, paid: '5.00' })));
  const p = parseShippingCostReport(s.rows, { requestedFrom: from, requestedTo: to });
  const r = await ingest(env, '/v1/ingest/shipping-cost-report', { format: 'csv_text', text: toCsvText(s.rows, s.columns), requestedFrom: from, requestedTo: to,
    rowCount: p.rowCount, shippingCostTotal: p.shippingCostCents / 100, exportedAt: '2026-09-21T15:00:00Z' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json;
}

test('C5: the mapping export alone never satisfies shipping readiness', async () => {
  const { env } = await loaded(20, {}, { shippingReport: false });          // Shopify week + mapping export + catalog
  assert.equal((await updatesScan(env)).status, 200);
  const r = await ready(env);
  assert.equal(r.ready, false);
  assert.deepEqual(r.missing, ['shipping_cost_report:missing']);
  assert.deepEqual([r.sources.shipstation_mapping.status, r.sources.shipstation_mapping.required, r.sources.shipstation_mapping.satisfiesShippingReadiness],
    ['ok', false, false]);
  assert.equal(r.sources.shipstation, undefined, 'no readiness key named after the mapping export');
  const sched = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK, trigger: 'schedule' });
  assert.deepEqual([sched.status, sched.json.error], [409, 'sources_not_ready']);
});

test('C5: a Shipping Cost Report received for the week satisfies it, even while pending review', async () => {
  const { env } = await loaded(20, {}, { shippingReport: false });
  await updatesScan(env);
  const v = await sendReport(env);
  assert.equal(v.status, 'pending_review');
  const r = await ready(env);
  assert.equal(r.ready, true, JSON.stringify(r.missing));
  assert.deepEqual([r.sources.shipping_cost_report.status, r.sources.shipping_cost_report.versionStatus, r.sources.shipping_cost_report.versionId],
    ['ok', 'pending_review', v.versionId]);
  assert.equal(r.sources.shipping_cost_report.trailingComplete, true);
  assert.equal(r.periodClosed, true);
});

test('C5: a rejected report, or one that does not cover the week, does not count', async () => {
  const { env } = await loaded(20, {}, { shippingReport: false });
  await updatesScan(env);
  const short = await sendReport(env, { to: '2026-09-18', rows: [{ order: '900001', date: '2026-09-15', cost: '5.10' }] });
  assert.ok((await ready(env)).missing.includes('shipping_cost_report:missing'), 'range ends before Sunday');
  const v = await sendReport(env, { rows: [{ order: '900002', date: '2026-09-16', cost: '6.20' }] });
  assert.equal((await admin(env, 'POST', `/v1/admin/shipping-cost/versions/${v.versionId}/reject`, { reason: 'test: rejected' })).status, 200);
  assert.ok((await ready(env)).missing.includes('shipping_cost_report:missing'), 'rejected version');
  assert.ok(short.versionId);
});

test('C5: an open reporting period is never ready', async () => {
  const { env } = await loaded(20);
  await updatesScan(env);
  const settings = await getSettings(env.DB);
  const before = await readiness(env.DB, WEEK, settings, { now: Date.parse('2026-09-21T06:59:00Z') });   // Sunday 23:59 PDT
  assert.equal(before.periodClosed, false);
  assert.ok(before.missing.includes('reporting_period:open'));
  const after = await readiness(env.DB, WEEK, settings, { now: Date.parse('2026-09-21T07:00:00Z') });
  assert.equal(after.periodClosed, true);
  assert.ok(!after.missing.includes('reporting_period:open'));
});

test('C5: mapping-export Rate, Carrier Fee, Insurance and Shipping Paid never become expense', async () => {
  const snapFor = async inflate => {
    const { env, nodes } = await loaded(20, {}, { verified: false, reportMissingEvery: 10 });
    if (inflate) {
      const rows = nodes.flatMap((o, i) => ssCustom({ shipment: `BIG${i}`, order: o.name.slice(1), fee: '999.00', rate: '888.00', insurance: '77.00', paid: '555.00' }));
      assert.equal((await ingest(env, '/v1/ingest/shipstation', { format: 'rows', rows, weekStart: WEEK })).status, 200);
    }
    assert.equal((await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK })).status, 200);
    return (await admin(env, 'GET', `/v1/snapshot/${WEEK}?includeDrafts=1`)).json.totals;
  };
  const base = await snapFor(false), inflated = await snapFor(true);
  assert.equal(inflated.shipStationExpense, base.shipStationExpense);
  assert.equal(inflated.shippingExpense, base.shippingExpense);
  assert.equal(inflated.operatingGpAfterShipping, base.operatingGpAfterShipping);
  // Orders with no report row stay uncovered even though the mapping export has a cost for them.
  assert.deepEqual([inflated.labels.c3.coverage.numerator, inflated.labels.c3.coverage.denominator],
    [base.labels.c3.coverage.numerator, base.labels.c3.coverage.denominator]);
  assert.ok(inflated.labels.c3.coverage.numerator < inflated.labels.c3.coverage.denominator);
});
