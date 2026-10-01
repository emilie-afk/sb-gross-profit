/**
 * Free-tier path: held Shipping Cost Report dates can be rejected. The dates already accepted stay,
 * the decision is audited, and the "newer report pending" publication block clears with the next draft revision.
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

test('reject held dates: the accepted dates of the version stay, the held dates are rejected and audited; the pending block clears', async () => {
  const env = await freeTierEnv(), c = client(env);
  const v1 = await firstAccepted(env, c);
  await autoAccept(env, true);
  // One version with new dates (activated) and a changed accepted cost (held).
  const changed = WEEK1.map(r => (r[1] === '900102' ? [r[0], r[1], '7.35'] : r));
  const v = await FT.uploadShippingCostReport(c, scrPayload(rows([...changed, ...NEXT]), FROM, addDays(TO, 7), '2026-08-18T15:00:00Z'));
  assert.equal(v.status, 'partially_accepted', JSON.stringify(v));
  assert.deepEqual(v.heldDates, ['2026-08-04']);
  assert.equal(await owner(env, '2026-08-10'), v.versionId, 'new date activated');
  assert.equal(await owner(env, '2026-08-04'), v1.versionId, 'held: accepted cost stays');
  const closedAt = weekWindowUtc(FROM, 'America/Los_Angeles').endUtcExclusive;
  assert.equal((await scrBasis(env.DB, FROM, closedAt)).newerPending.length, 1, 'held dates block publication of that week');

  assert.equal((await api(env, 'POST', `/v1/admin/scr/versions/${v.versionId}/reject`, {})).status, 400, 'a decision needs a reason');
  const r = await ok(api(env, 'POST', `/v1/admin/scr/versions/${v.versionId}/reject`, { reason: 'test: carrier adjustment not confirmed' }), 'reject held');
  assert.equal(r.status, 'accepted');
  assert.deepEqual(r.rejectedDates, ['2026-08-04']);
  assert.deepEqual(r.affectedWeeks, [FROM], 'exactly the week whose basis changed');
  assert.equal(await owner(env, '2026-08-10'), v.versionId, 'dates already accepted are preserved');
  assert.equal(await owner(env, '2026-08-04'), v1.versionId, 'the accepted cost stays in force');
  assert.equal((await env.DB.prepare("SELECT outcome FROM scr_day WHERE version_id = ?1 AND ship_date = '2026-08-04'").bind(v.versionId).first()).outcome, 'rejected_on_review');
  const b = await scrBasis(env.DB, FROM, closedAt);
  assert.equal(b.newerPending.length, 0, 'the pending publication block is cleared');
  const detail = (await api(env, 'GET', `/v1/admin/scr/versions/${v.versionId}`)).json;
  assert.deepEqual([detail.status, detail.decisionReason], ['accepted', 'test: carrier adjustment not confirmed']);
  const log = await decisions(env, v.versionId);
  assert.deepEqual(log.map(x => x.kind), ['auto_activate', 'reject_held']);
  assert.deepEqual([log[1].actor_class, log[1].reason, JSON.parse(log[1].dates), JSON.parse(log[1].weeks)], ['admin_secret', 'test: carrier adjustment not confirmed', ['2026-08-04'], [FROM]]);
  // Decided once: neither a second rejection nor an acceptance applies now.
  assert.equal((await api(env, 'POST', `/v1/admin/scr/versions/${v.versionId}/reject`, { reason: 'test: again' })).status, 409);
  assert.equal((await api(env, 'POST', `/v1/admin/scr/versions/${v.versionId}/accept`, { reason: 'test: too late' })).status, 409);
});

test('reject a version pending review: nothing of it activates; the decision is audited', async () => {
  const env = await freeTierEnv(), c = client(env);
  const v1 = await firstAccepted(env, c);
  const changed = WEEK1.map(r => (r[1] === '900103' ? [r[0], r[1], '9.99'] : r));
  const v = await FT.uploadShippingCostReport(c, scrPayload(rows(changed), FROM, TO, '2026-08-11T15:00:00Z'));
  assert.equal(v.status, 'pending_review');
  const r = await ok(api(env, 'POST', `/v1/admin/scr/versions/${v.versionId}/reject`, { reason: 'test: wrong export' }), 'reject');
  assert.equal(r.status, 'rejected');
  assert.equal(await owner(env, '2026-08-05'), v1.versionId);
  const log = await decisions(env, v.versionId);
  assert.deepEqual(log.map(x => x.kind), ['reject_version']);
});

test('reject held dates end to end: the week shows the block, then compute_pending, then a new verified revision without the block', async () => {
  const d = dataset({ n: 120, scr: { zeroEvery: 1e9 } });
  const ft = await freeTierRun(d);
  const env = ft.env, c = ft.c;
  await autoAccept(env, true);
  const week = d.weeks[7];
  // Re-export of the whole window with one accepted cost in the closed week changed → that date is held.
  const raw = parseCSV(d.scr.text).map(x => ({ ...x, Recipient: 'X', 'Shipping Paid': '0', '+/-': '0' }));
  const i = raw.findIndex(x => { const [m, dd, y] = x['Ship Date'].split(' ')[0].split('/'); const iso = `${y}-${m.padStart(2, '0')}-${dd.padStart(2, '0')}`; return iso >= week && iso <= addDays(week, 6); });
  raw[i] = { ...raw[i], 'Shipping Cost': (Number(raw[i]['Shipping Cost']) + 1.11).toFixed(2) };
  const v = await FT.uploadShippingCostReport(c, scrPayload(raw, d.win.from, d.win.to, `${addDays(d.win.to, 3)}T15:00:00Z`));
  assert.equal(v.status, 'partially_accepted', JSON.stringify(v.reviewReasons));
  const st = async () => (await api(env, 'GET', `/v1/weeks/${week}/status`)).json;
  assert.equal((await st()).state, 'shipping_report_newer_pending');
  const blocked = await FT.computeAndUploadWeek(c, week, ft.cache);
  const gateOf = async id => JSON.parse((await env.DB.prepare('SELECT r.gate FROM snapshot s JOIN reporting_run r ON r.run_id = s.run_id WHERE s.snapshot_id = ?1').bind(id).first()).gate);
  assert.equal((await gateOf(blocked.snapshotId)).shippingReport.newerPending.length, 1, 'this draft carries the publication block');

  // Bring another week up to date first (the audited auto-acceptance change is itself an input of every week).
  assert.equal((await FT.computeAndUploadWeek(c, d.weeks[0], ft.cache)).status, 'computed');
  const r = await ok(api(env, 'POST', `/v1/admin/scr/versions/${v.versionId}/reject`, { reason: 'test: adjustment not confirmed' }), 'reject held');
  assert.ok(r.affectedWeeks.includes(week));
  assert.equal((await st()).state, 'compute_pending', 'the block is gone from the inputs; a new draft is needed');
  const next = await FT.computeAndUploadWeek(c, week, ft.cache);
  assert.equal(next.status, 'computed');
  assert.equal(next.revision, blocked.revision + 1);
  assert.equal((await gateOf(next.snapshotId)).shippingReport.newerPending.length, 0, 'the new draft has no publication block');
  assert.equal((await runVerifier(env, next.snapshotId)).body.status, 'verified');
  assert.equal((await st()).state, 'verified');
  // A week the rejection did not affect stays current: its manifest is unchanged.
  const other = await FT.computeAndUploadWeek(c, d.weeks[0], ft.cache);
  assert.equal(other.status, 'unchanged');
});
