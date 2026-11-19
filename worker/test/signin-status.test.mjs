/**
 * Shopify sign-in that needs a person (2026-10-06): the collector tells the Worker, the week's status
 * says so first (with when it started), and it clears when the person signed in or the export arrived.
 * Codes and numbers only; nothing else is accepted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freeTierEnv, api, ok, dataset } from './freeTierHarness.mjs';
import * as FT from '../../automation/collector/src/freeTier.mjs';
import { bridge, ORIGIN } from './freeTierHarness.mjs';
import { renderAutomationStatus } from '../../js/automationStatus.js';

test('sign-in status: needs a person → shown first on the week; signed in or an export clears it; payloads are validated', async () => {
  const d = dataset({ n: 40 });
  const env = await freeTierEnv();
  const W = d.week.weekStart;
  const status = async () => (await ok(api(env, 'GET', `/v1/collect/weeks/${W}/status`, undefined, 'ingest'), 'status'));
  assert.equal((await status()).attention, undefined);
  for (const bad of [{ status: 'done' }, { status: 'needs_person', authState: 'password' }, { status: 'needs_person', waitMinutes: 999 }]) {
    assert.equal((await api(env, 'POST', `/v1/collect/weeks/${W}/signin`, bad, 'ingest')).status, 400, JSON.stringify(bad));
  }
  assert.equal((await api(env, 'POST', `/v1/collect/weeks/${W}/signin`, { status: 'needs_person' })).status, 401, 'ingest secret only');
  await ok(api(env, 'POST', `/v1/collect/weeks/${W}/signin`, { status: 'needs_person', authState: 'two_factor_required', waitMinutes: 30 }, 'ingest'), 'event');
  const s = await status();
  assert.equal(s.pending[0].code, 'shopify_signin_required');
  assert.ok(s.pending.some(p => p.code === 'shopify_export_pending'));
  assert.deepEqual([s.attention.code, s.attention.authState, typeof s.attention.since], ['shopify_signin_required', 'two_factor_required', 'string']);
  // The dashboard's automation panel shows it as the action needed.
  assert.match(renderAutomationStatus({ weekStart: W, freeTier: s }), /Action needed.*Shopify needs a person to sign in/);
  // The collector's own call (as the weekly run sends it), then "signed in" clears it.
  const ft = FT.freeTierPipeline({ workerUrl: ORIGIN, ingestSecret: env.INGEST_SECRET, closedWeek: W, fetchImpl: bridge(env), sleep: async () => {} });
  assert.equal((await ft.weekPlan()).collected.shopify, 'missing', 'the export is still collected on the next attempt');
  await new Promise(r => setTimeout(r, 5));
  await ft.signInEvent('signed_in');
  const after = await status();
  assert.equal(after.attention, undefined);
  assert.ok(!after.pending.some(p => p.code === 'shopify_signin_required'));
  // Waiting again, then the export arrives: cleared without a "signed in" event.
  await new Promise(r => setTimeout(r, 5));
  await ft.signInEvent('needs_person', { authState: 'captcha', waitMinutes: 30 });
  assert.equal((await status()).attention.authState, 'captcha');
  await new Promise(r => setTimeout(r, 5));
  await FT.uploadShopifyOrders(ft.client, d.shopify);
  const done = await status();
  assert.equal(done.attention, undefined);
  assert.ok(!done.pending.some(p => p.code === 'shopify_signin_required' || p.code === 'shopify_export_pending'), JSON.stringify(done.pending));
});
