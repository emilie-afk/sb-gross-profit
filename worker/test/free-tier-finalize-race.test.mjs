/**
 * Free-tier path: finalize cannot commit results computed from inputs that changed between its
 * manifest check and its transaction (the input epoch is checked inside the transaction).
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

test('finalize: an input written between the manifest check and the commit cannot finalize stale results', async () => {
  const d = dataset({ n: 120, scr: { zeroEvery: 1e9 } });
  const ft = await freeTierRun(d, { verify: false });
  const env = ft.env, c = ft.c, week = d.weeks[7];
  // Force a recompute of the week: an audited setting change is an input.
  await ok(api(env, 'POST', '/v1/admin/settings', { mcg_free_shipping_threshold: 91, reason: 'test: new input' }), 'settings');
  const realBatch = env.DB.batch.bind(env.DB);
  let inject = null;
  env.DB.batch = async stmts => {
    if (inject && stmts.some(s => /INSERT INTO snapshot \(snapshot_id/.test(s.sql))) { const f = inject; inject = null; await f(); }
    return realBatch(stmts);
  };
  const before = (await env.DB.prepare('SELECT COUNT(*) AS n FROM snapshot WHERE week_start = ?1').bind(week).first()).n;

  // (a) The intervening write changes this week's inputs (a setting every week reads): refused, then inputs_changed.
  inject = () => env.DB.prepare("UPDATE settings SET value = '92' WHERE key = 'mcg_free_shipping_threshold'").run();
  const a = await FT.computeAndUploadWeek(c, week, ft.cache);
  assert.deepEqual([a.status, a.code], ['pending', 'inputs_changed']);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM snapshot WHERE week_start = ?1').bind(week).first()).n, before, 'no stale snapshot');
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM result_upload WHERE week_start = ?1 AND status = 'abandoned'").bind(week).first()).n, 1);

  // (b) The intervening write touches another table the manifest reads but not this week's inputs: the first
  //     commit is refused inside the transaction (inputs_moved), the retry re-checks and commits.
  inject = () => env.DB.prepare("UPDATE ord_ptr SET source_id = source_id WHERE week_start = ?1").bind(d.weeks[0]).run();
  let moved = 0;
  const realCall = c.call;
  c.call = async (m, p, o) => { try { return await realCall(m, p, o); } catch (e) { if (e.code === 'inputs_moved') moved++; throw e; } };
  const b = await FT.computeAndUploadWeek(c, week, ft.cache);
  c.call = realCall;
  assert.equal(moved, 1, 'the commit was refused once inside the transaction');
  assert.equal(b.status, 'computed');
  assert.equal((await runVerifier(env, b.snapshotId)).body.status, 'verified', 'the committed result matches its inputs');

  // (c) Directly: finalize with no intervening write commits; the epoch guard sits inside the same batch.
  env.DB.batch = realBatch;
  const epoch0 = (await env.DB.prepare('SELECT n FROM input_epoch WHERE id = 1').first()).n;
  await env.DB.prepare("UPDATE settings SET value = '93' WHERE key = 'mcg_free_shipping_threshold'").run();
  assert.equal((await env.DB.prepare('SELECT n FROM input_epoch WHERE id = 1').first()).n, epoch0 + 1, 'every input write moves the epoch');
  assert.equal((await FT.computeAndUploadWeek(c, week, ft.cache)).status, 'computed');
});
