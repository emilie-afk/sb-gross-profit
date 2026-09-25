/**
 * C3 in the Worker: the Shipping Cost Report is the expense source, audited
 * shipping-policy settings, lifecycle across report versions, and the five
 * controls. Synthetic data only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeEnv, loaded, admin, ingestReport, WEEK } from './helpers.mjs';
import { buildSnapshot } from '../../shared/snapshot.js';
import { csvRowsToNormalizedOrders } from '../../shared/adapters/legacy.js';
import { FIXTURE_CATALOG } from '../../tests/fixtures-normalized.mjs';
import { row } from '../../tests/fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('compute takes shipping expense from the Shipping Cost Report, not the mapping export', async () => {
  const { env } = await loaded(20, {}, { verified: false });
  const r = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  const s = (await admin(env, 'GET', `/v1/snapshot/${WEEK}?includeDrafts=1`)).json;
  // Report: 5.40 for order 0, 5.10 for the other 19. The mapping export had a zero fee for order 0.
  assert.equal(s.totals.shipStationExpense, Math.round((5.40 + 19 * 5.10) * 100) / 100);
  const c3 = s.totals.labels.c3;
  assert.equal(c3.source, 'shipping_cost_report');
  assert.deepEqual([c3.coverage.numerator, c3.coverage.denominator], [20, 20]);
  assert.equal(c3.lifecycle.status, 'shipping_order_coverage_complete');
  assert.equal(c3.disclosures.shippingSource.status, 'unverified');
  assert.equal(c3.disclosures.catalogVersion, s.catalogRev);
  assert.equal(r.json.state, 'blocked');
  assert.ok(r.json.gate.failures.some(f => f.code === 'shipping_source_unverified'));
  assert.ok(!r.json.gate.failures.some(f => f.code === 'shipping_order_coverage_open'));
});

test('a later report version that changes a week makes the next compute "updated" and touches that week', async () => {
  const { env, nodes } = await loaded(20, {}, { reportMissingEvery: 10 });
  const a = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  assert.equal(a.json.gate.failures.find(f => f.code === 'shipping_order_coverage_open')?.code, 'shipping_order_coverage_open');
  // The next report (same dates) now has a row for order 0; order 10 is still missing.
  await ingestReport(env, nodes.map((o, i) => ({ order: o.name.slice(1), date: `2026-09-${15 + (i % 5)}`, cost: i % 20 === 0 ? 5.40 : 5.10 })).filter((_, i) => i !== 10));
  const b = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  const s = (await admin(env, 'GET', `/v1/snapshot/${WEEK}?includeDrafts=1`)).json;
  assert.equal(s.revision, 2);
  assert.equal(s.totals.labels.c3.lifecycle.status, 'shipping_order_coverage_updated');
  assert.deepEqual([s.totals.labels.c3.coverage.numerator, s.totals.labels.c3.coverage.denominator], [19, 20]);
  assert.ok(b.json.snapshotId);
});

test('shipping-policy settings are audited, need a reason, and are validated; provisional publication stays off', async () => {
  const env = await makeEnv();
  const s = (await admin(env, 'GET', '/v1/admin/settings')).json;
  assert.deepEqual(s.settings.vendor_first_paid_shipping_dates, { 'Air Plant Shop': '2026-08-14', 'Live to Give': '2026-09-15', 'Surfside Arrangement': '2026-09-15' });
  assert.deepEqual([s.settings.mcg_free_shipping_threshold, s.settings.shipping_coverage_aging_days, s.settings.provisional_publication_enabled], [89, 14, false]);
  const audit = (await env.DB.prepare("SELECT key, reason, actor_class FROM settings_audit WHERE actor_label = '0009_c3_shipping_policy'").all()).results;
  assert.equal(audit.length, 4);
  const next = { ...s.settings.vendor_first_paid_shipping_dates, 'Air Plant Shop': '2026-08-15' };
  assert.equal((await admin(env, 'POST', '/v1/admin/settings', { vendor_first_paid_shipping_dates: next })).status, 400, 'reason required');
  assert.equal((await admin(env, 'POST', '/v1/admin/settings', { vendor_first_paid_shipping_dates: { Nobody: '2026-01-01' }, reason: 'bad vendor' })).status, 400);
  assert.equal((await admin(env, 'POST', '/v1/admin/settings', { vendor_first_paid_shipping_dates: { 'Air Plant Shop': '14/08/2026' }, reason: 'bad date' })).status, 400);
  assert.equal((await admin(env, 'POST', '/v1/admin/settings', { vendor_first_paid_shipping_dates: next, reason: 'cut-off moved one day (test)' })).status, 200);
  const row1 = await env.DB.prepare("SELECT old_value, new_value, reason FROM settings_audit WHERE key = 'vendor_first_paid_shipping_dates' ORDER BY id DESC LIMIT 1").first();
  assert.match(row1.new_value, /2026-08-15/);
  assert.equal((await admin(env, 'POST', '/v1/admin/settings', { provisional_publication_enabled: true, reason: 'try (test)' })).status, 400);
  assert.equal((await admin(env, 'POST', '/v1/admin/settings', { shipping_coverage_aging_days: 0, reason: 'bad' })).status, 400);
});

test('all five controls are off in configuration: the scheduled path refuses unless AUTOMATION_ENABLED is "true"', async () => {
  const toml = fs.readFileSync(path.join(HERE, '..', 'wrangler.toml'), 'utf8');
  for (const v of ['PUBLICATION_ALLOWED', 'AUTOMATION_ENABLED']) assert.equal((toml.match(new RegExp(`^${v} = "false"$`, 'gm')) || []).length, 2, `${v} false in production and staging`);
  assert.ok(!/^(PUBLICATION_ALLOWED|AUTOMATION_ENABLED) = "true"/m.test(toml));
  assert.ok(!/TEST_HOOK/.test(toml));
  const env = await makeEnv({ AUTOMATION_ENABLED: 'false' });
  const s = (await admin(env, 'GET', '/v1/admin/settings')).json;
  assert.deepEqual([s.settings.shipping_cost_report_source_verified, s.settings.provisional_publication_enabled, s.settings.publication_enabled,
                    s.publicationAllowedInEnvironment, s.automationEnabledInEnvironment], [false, false, false, false, false]);
  const r = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK, trigger: 'schedule' });
  assert.deepEqual([r.status, r.json.error], [409, 'automation_disabled']);
});

test('cancelled after shipping flows through the snapshot contract with every reconciliation check passing', () => {
  const rows = [
    row({ Name: '#996001', 'Lineitem sku': 'MG-ALOE', Vendor: 'Succulents Box', 'Lineitem price': '20.00', Subtotal: '20.00', Shipping: '6.99', Total: '26.99',
          'Refunded Amount': '20.00', 'Fulfillment Status': 'fulfilled', 'Fulfilled at': '2026-09-15 09:00:00 -0700', 'Cancelled at': '2026-09-16 10:00:00 -0700',
          'Created at': '2026-09-15 08:00:00 -0700' }),
    row({ Name: '#996002', 'Lineitem sku': 'MG-JADE', Vendor: 'Succulents Box', 'Lineitem price': '18.00', Subtotal: '18.00', Shipping: '5.00', Total: '23.00',
          'Created at': '2026-09-15 08:00:00 -0700' }),
  ];
  const report = new Map([['996001', { orderKey: '996001', costCents: 510, rowCount: 1, firstShipDate: '2026-09-15', lastShipDate: '2026-09-15' }],
                          ['996002', { orderKey: '996002', costCents: 450, rowCount: 1, firstShipDate: '2026-09-16', lastShipDate: '2026-09-16' }]]);
  const snap = buildSnapshot({ weekStart: '2026-09-14', orders: csvRowsToNormalizedOrders(rows), catalog: FIXTURE_CATALOG,
                               shippingSource: 'shipping_cost_report', shippingCostReport: report, c3: { asOf: '2026-09-21T09:00:00Z' } });
  assert.ok(snap.reconciliation.filter(c => c.blocking).every(c => c.passed), JSON.stringify(snap.reconciliation.filter(c => !c.passed)));
  assert.equal(snap.totals.shippingExpense, 9.6);
  assert.equal(snap.totals.shippingCollected, 11.99);
  assert.equal(snap.shipping.c3.counts.cancelledAfterShippingOrders, 1);
  assert.deepEqual([snap.shipping.c3.coverage.numerator, snap.shipping.c3.coverage.denominator], [2, 2]);
});
