/** Revision 6 acceptance tests for the pure shared modules (no Worker, no D1). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGate, canPublish, DEFAULT_SETTINGS } from '../shared/gate.js';
import { profitabilityStatus, PROFITABILITY_STATUS } from '../shared/metrics.js';
import { buildNarrative, draftComparison } from '../shared/narrative.js';
import { classifyCreatedBy, normalizeShipStationRows } from '../shared/adapters/shipstation.js';
import { ssCustom } from './fixtures-normalized.mjs';

const totals = (o = {}) => ({ routeNet: 0, ordersRequiringShipStationRate: 10, ordersWithValidShipStationRate: 10, missingCostLines: 0,
  hpdOrdersPassThrough: 0, insuranceDisclosed: 0, labels: { notes: [] }, operatingGpAfterShipping: 100, operatingRevenue: 200,
  profitabilityStatus: 'complete', knownCostProductGp: 80, knownCostProductMargin: 40, routeCollected: 0, ...o });
const ok = { shopify: 'ok', shipstation: 'ok', hpd: 'ok' };
const current = { accepted: true, rev: 'cat_a', freshness: { status: 'current' } };
const ON = { ...DEFAULT_SETTINGS, publication_enabled: true, store_timezone_confirmed: true };

test('an unlocked Carrier Fee priority is a blocking gate failure, and both switches cannot override it', () => {
  const g = evaluateGate({ totals: totals(), reconciliation: [], sources: ok, catalog: current, settings: { ...DEFAULT_SETTINGS, store_timezone_confirmed: true } });
  assert.equal(g.passed, false);
  assert.ok(g.failures.some(f => f.code === 'carrier_fee_priority'));
  assert.equal(canPublish({ passed: true }, ON, 'true').reason, 'carrier_fee_priority_unlocked');   // even a passed gate
  assert.equal(canPublish({ passed: true }, { ...ON, carrier_fee_priority_locked: 'true' }, 'true').allowed, false); // strings do not count
  assert.equal(canPublish({ passed: true }, { ...ON, carrier_fee_priority_locked: true }, 'true').allowed, true);
});

test('a stale or unrecorded catalog blocks; accepted reuse and intentional reuse do not', () => {
  const L = { ...DEFAULT_SETTINGS, carrier_fee_priority_locked: true, store_timezone_confirmed: true };
  const gate = freshness => evaluateGate({ totals: totals(), reconciliation: [], sources: ok, catalog: { accepted: true, rev: 'c', freshness }, settings: L });
  assert.ok(gate({ status: 'stale', reason: 'refresh_rejected' }).failures.some(f => f.code === 'catalog_stale'));
  assert.ok(gate(undefined).failures.some(f => f.code === 'catalog_stale'));
  for (const status of ['current', 'intentionally_reused', 'restated']) assert.equal(gate({ status }).passed, true, status);
  const acc = gate({ status: 'reused_accepted', acceptance: { reason: 'build down, sheets unchanged' } });
  assert.equal(acc.passed, true);
  assert.ok(acc.warnings.some(w => w.code === 'catalog_reused'));
});

test('HPD pass-through can never be classified complete', () => {
  assert.equal(profitabilityStatus(true, true, true), PROFITABILITY_STATUS.PROVISIONAL_HPD_PASS_THROUGH);
  assert.equal(profitabilityStatus(true, true, false), PROFITABILITY_STATUS.COMPLETE);
  assert.equal(profitabilityStatus(false, true, true), PROFITABILITY_STATUS.PROVISIONAL_MISSING_COSTS);
  const L = { ...DEFAULT_SETTINGS, carrier_fee_priority_locked: true, store_timezone_confirmed: true };
  const g = evaluateGate({ totals: totals({ hpdOrdersPassThrough: 3 }), reconciliation: [], sources: { ...ok, hpd: 'pending' }, catalog: current, settings: L });
  assert.ok(g.warnings.some(w => w.code === 'hpd_pass_through_assumed'));
});

test('the stored narrative refuses a non-published prior week; the draft comparison is labelled a preview', () => {
  const cur = { weekStart: '2026-09-14', totals: totals(), breakdowns: {} };
  assert.throws(() => buildNarrative(cur, { weekStart: '2026-09-07', status: 'blocked', totals: totals() }), /published/);
  const n = buildNarrative(cur, { weekStart: '2026-09-07', status: 'published', snapshotId: 'snp_1', totals: totals({ operatingRevenue: 150 }) });
  assert.deepEqual(n.comparison, { basis: 'published', weekStart: '2026-09-07', snapshotId: 'snp_1' });
  const d = draftComparison(cur, { weekStart: '2026-09-07', status: 'draft', totals: totals() });
  assert.match(d.label, /DRAFT PREVIEW/);
  assert.equal(d.basis, 'draft');
  assert.equal(buildNarrative(cur, null).comparison, null);
});

test('ShipStation Created By leaves the adapter only as a non-identifying class', () => {
  assert.equal(classifyCreatedBy(''), 'blank');
  assert.equal(classifyCreatedBy('staff.person@example.invalid'), 'person');
  assert.equal(classifyCreatedBy('Jane'), 'person');
  assert.equal(classifyCreatedBy('Shopify integration'), 'integration');
  assert.equal(classifyCreatedBy('api@example.invalid'), 'person');           // an address is never an "integration"
  const { shipments } = normalizeShipStationRows(ssCustom({ extra: { 'Created By': 'staff.person@example.invalid' } }));
  assert.equal(shipments[0].createdByClass, 'person');
  assert.ok(!JSON.stringify(shipments).includes('staff.person'));
  assert.ok(!('createdBy' in shipments[0]));
});

test('already-classified Created By values pass through unchanged (backfill sends the class, not the name)', () => {
  for (const c of ['blank', 'integration', 'person']) assert.equal(classifyCreatedBy(c), c);
});
