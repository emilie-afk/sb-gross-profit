/**
 * Free-tier path: Shipping Cost Report auto-acceptance is an explicit, audited switch (default off).
 * Off → every version that would activate or hold a date goes to review; on → the owner-approved rules.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freeTierEnv, api, ok, client, scrPayload, dataset, freeTierRun, runVerifier } from './freeTierHarness.mjs';
import * as FT from '../../automation/collector/src/freeTier.mjs';
import { reportRow } from '../../tests/fixtures-shipping-cost.mjs';
import { addDays } from '../../shared/normalized.js';
import { parseCSV } from '../../shared/calculator.js';
import { scrBasis } from '../src/collectScr.js';
import { weekWindowUtc } from '../../shared/schedule.js';

const FROM = '2026-08-03', TO = '2026-08-09';
const rows = list => list.map(([date, order, cost]) => reportRow({ date, order, cost, paid: '5.00' }));
const WEEK1 = [['2026-08-03', '900101', '6.25'], ['2026-08-04', '900102', '7.10'], ['2026-08-05', '900103', '5.55'], ['2026-08-06', '900104', '8.00'], ['2026-08-07', '900105', '6.00']];
const NEXT = [['2026-08-10', '900201', '6.10'], ['2026-08-12', '900202', '5.20']];
const autoAccept = (env, on) => ok(api(env, 'POST', '/v1/admin/settings', { shipping_cost_auto_accept_enabled: on, reason: `test: auto-acceptance ${on ? 'on' : 'off'}` }), 'auto-accept setting');
const owner = async (env, d) => (await env.DB.prepare('SELECT version_id FROM scr_day_owner WHERE ship_date = ?1').bind(d).first())?.version_id || null;
const decisions = async (env, id) => (await env.DB.prepare('SELECT kind, actor_class, reason, dates, weeks FROM scr_decision WHERE version_id = ?1 ORDER BY at, decision_id').bind(id).all()).results;
async function firstAccepted(env, c) {
  const v = await FT.uploadShippingCostReport(c, scrPayload(rows(WEEK1), FROM, TO));
  await ok(api(env, 'POST', `/v1/admin/scr/versions/${v.versionId}/accept`, { reason: 'test: first version reviewed' }), 'accept');
  return v;
}

test('auto-acceptance: off by default — new dates, fill-ins and held dates all wait for review; identical re-exports stay no-ops', async () => {
  const env = await freeTierEnv(), c = client(env);
  const settings = (await api(env, 'GET', '/v1/admin/settings')).json.settings;
  assert.equal(settings.shipping_cost_auto_accept_enabled, false, 'the default is off');
  const v1 = await firstAccepted(env, c);
  // New dates after the accepted coverage: review, nothing activated.
  const v2 = await FT.uploadShippingCostReport(c, scrPayload(rows([...WEEK1, ...NEXT]), FROM, addDays(TO, 7), '2026-08-18T15:00:00Z'));
  assert.equal(v2.status, 'pending_review');
  assert.deepEqual(v2.reviewReasons, ['auto_acceptance_disabled']);
  assert.equal(await owner(env, '2026-08-10'), null, 'nothing activated');
  // A changed accepted cost: review of the whole version (not partially accepted), the accepted cost stays.
  const changed = WEEK1.map(r => (r[1] === '900102' ? [r[0], r[1], '7.35'] : r));
  const v3 = await FT.uploadShippingCostReport(c, scrPayload(rows(changed), FROM, TO, '2026-08-11T15:00:00Z'));
  assert.equal(v3.status, 'pending_review');
  assert.deepEqual(v3.reviewReasons, ['auto_acceptance_disabled']);
  assert.equal(await owner(env, '2026-08-04'), v1.versionId);
  // An identical re-export (another file, same content): nothing to accept, so no review is needed.
  const same = await FT.uploadShippingCostReport(c, scrPayload(rows([...WEEK1].reverse()), FROM, TO, '2026-08-12T15:00:00Z'));
  assert.equal(same.status, 'no_change');
  assert.deepEqual(same.reviewReasons, []);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM scr_decision WHERE kind = 'auto_activate'").first()).n, 0);
});

test('auto-acceptance: switching it needs a stated reason and is audited; on → the owner rules apply; off again → review', async () => {
  const env = await freeTierEnv(), c = client(env);
  const v1 = await firstAccepted(env, c);
  assert.equal((await api(env, 'POST', '/v1/admin/settings', { shipping_cost_auto_accept_enabled: true })).status, 400, 'a reason is required');
  assert.equal((await api(env, 'POST', '/v1/admin/settings', { shipping_cost_auto_accept_enabled: 'yes', reason: 'test: not a boolean' })).status, 400);
  await autoAccept(env, true);
  const audit = await env.DB.prepare("SELECT COUNT(*) AS n FROM settings_audit WHERE key = 'shipping_cost_auto_accept_enabled'").first();
  assert.equal(audit.n, 1, 'the change is audited');
  const v2 = await FT.uploadShippingCostReport(c, scrPayload(rows([...WEEK1, ...NEXT]), FROM, addDays(TO, 7), '2026-08-18T15:00:00Z'));
  assert.equal(v2.status, 'accepted', JSON.stringify(v2));
  assert.deepEqual(v2.reviewReasons, []);
  assert.equal(await owner(env, '2026-08-10'), v2.versionId);
  assert.equal(await owner(env, '2026-08-04'), v1.versionId, 'identical dates keep their owner');
  const [auto] = await decisions(env, v2.versionId);
  assert.equal(auto.kind, 'auto_activate');
  assert.deepEqual(JSON.parse(auto.dates), Array.from({ length: 7 }, (_, i) => addDays('2026-08-10', i)), 'the seven new dates');
  await autoAccept(env, false);
  const v3 = await FT.uploadShippingCostReport(c, scrPayload(rows([...WEEK1, ...NEXT, ['2026-08-17', '900301', '6.00']]), FROM, addDays(TO, 14), '2026-08-25T15:00:00Z'));
  assert.equal(v3.status, 'pending_review');
  assert.deepEqual(v3.reviewReasons, ['auto_acceptance_disabled']);
  assert.equal(await owner(env, '2026-08-17'), null);
});
