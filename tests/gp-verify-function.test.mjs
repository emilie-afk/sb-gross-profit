/**
 * gp-verify (Netlify Function): refuses unauthenticated or malformed calls, answers counts only,
 * and a sweep verifies every pending snapshot. The Worker and the verifier core are real code.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import gpVerify from '../netlify/functions/gp-verify.mjs';
import { dataset, freeTierRun, bridge, ORIGIN, TRIGGER } from '../worker/test/freeTierHarness.mjs';

const call = (env, body, headers = { 'x-verify-trigger': TRIGGER }, method = 'POST', logs = []) =>
  gpVerify(new Request('https://site.test/.netlify/functions/gp-verify', { method, headers: { 'Content-Type': 'application/json', ...headers }, body: method === 'POST' ? JSON.stringify(body) : undefined }),
    { env, fetchImpl: bridge(env.__worker), log: s => logs.push(s) });

test('gp-verify refuses a missing or wrong trigger secret, other methods, bad payloads and a missing configuration', async () => {
  const env = { SB_WORKER_ORIGIN: ORIGIN, SB_VERIFY_SECRET: 'x'.repeat(40), SB_VERIFY_TRIGGER_SECRET: TRIGGER, __worker: {} };
  assert.equal((await call(env, { snapshotId: 'snp_00000000000000000000' }, {})).status, 401);
  assert.equal((await call(env, { snapshotId: 'snp_00000000000000000000' }, { 'x-verify-trigger': 'nope' })).status, 401);
  assert.equal((await call(env, {}, undefined, 'GET')).status, 405);
  assert.equal((await call(env, { snapshotId: '../etc' })).status, 400);
  assert.equal((await call({ ...env, SB_WORKER_ORIGIN: 'http://insecure' }, { snapshotId: 'snp_00000000000000000000' })).status, 503);
});

test('gp-verify sweep verifies every pending collector-computed week; the answer and logs are counts only', { timeout: 300_000 }, async () => {
  const d = dataset({ n: 90 });
  const ft = await freeTierRun(d, { verify: false });
  const env = { SB_WORKER_ORIGIN: ORIGIN, SB_VERIFY_SECRET: ft.env.VERIFY_SECRET, SB_VERIFY_TRIGGER_SECRET: TRIGGER, __worker: ft.env };
  const logs = [];
  const r = await call(env, { sweep: true }, undefined, 'POST', logs);
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual([j.status, j.checked, j.verified, j.mismatch || 0, j.notRecorded], ['swept', d.weeks.length, d.weeks.length, 0, 0]);
  assert.deepEqual(Object.keys(j).sort(), ['checked', 'mismatch', 'notRecorded', 'skipped', 'status', 'totalMs', 'unavailable', 'verified'].sort());
  assert.ok(logs.length === 1 && !logs[0].includes('#'));
  const again = await (await call(env, { sweep: true })).json();
  assert.equal(again.checked, 0, 'nothing left pending');
});
