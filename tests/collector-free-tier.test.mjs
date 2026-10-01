/**
 * Collector orchestration on the Free-tier path: the two collectors' upload calls go through
 * freeTierPipeline().uploadImpl, then the compute step computes, uploads and requests
 * verification. Browsers and Gmail are faked; the Worker and the verifier are real code.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWeeklyCollection } from '../automation/collector/src/orchestrate.mjs';
import { freeTierPipeline } from '../automation/collector/src/freeTier.mjs';
import gpVerify from '../netlify/functions/gp-verify-background.mjs';
import { dataset, freeTierEnv, api, ok, bridge, ORIGIN, TRIGGER } from '../worker/test/freeTierHarness.mjs';

async function setup(d) {
  const env = await freeTierEnv();
  await ok(api(env, 'POST', '/v1/admin/settings', { carrier_fee_priority_locked: true, reason: 'test: priority locked' }), 'settings');
  await ok(api(env, 'POST', '/v1/ingest/catalog', d.catalog, 'ingest'), 'catalog');
  const toWorker = bridge(env);
  const verifyEnv = { SB_WORKER_ORIGIN: ORIGIN, SB_VERIFY_SECRET: env.VERIFY_SECRET, SB_VERIFY_TRIGGER_SECRET: TRIGGER };
  const logs = [];
  // The PC reaches the Worker directly and the verifier through its Netlify URL.
  const fetchImpl = async (url, init) => url.startsWith('https://site.test/')
    ? gpVerify(new Request(url, init), { env: verifyEnv, fetchImpl: toWorker, log: s => logs.push(s) })
    : toWorker(url, init);
  return { env, fetchImpl, logs };
}

function run(d, ft, dir, { collectedReport = true } = {}) {
  return runWeeklyCollection({
    week: { weekStart: d.week.weekStart, weekEnd: d.week.weekEnd, closed: true },
    lockFile: path.join(dir, 'lock'), stateFile: path.join(dir, 'state.json'),
    weekPlan: () => ft.weekPlan(),
    shipstation: {
      collect: async () => ({ status: 'prepared', exitCode: 0, pending: { payload: d.scr } }),
      upload: async p => { const r = await ft.uploadImpl({ path: '/v1/ingest/shipping-cost-report', payload: p.payload }); return { status: r.ok ? 'ok' : 'upload_failed', exitCode: r.ok ? 0 : 31, r }; },
    },
    shopify: { run: async ({ onWaiting }) => { await onWaiting(); const r = await ft.uploadImpl({ path: '/v1/ingest/shopify', payload: d.shopify }); return { status: r.ok ? 'ok' : 'upload_failed', exitCode: r.ok ? 0 : 32 }; } },
    compute: () => ft.compute(),
    ...(collectedReport ? {} : {}),
  });
}

test('collector on the Free-tier path: collect → upload → compute every week → verified; a second run collects nothing', { timeout: 300_000 }, async () => {
  const d = dataset({ n: 150, scr: { zeroEvery: 1e9 } });
  const { env, fetchImpl, logs } = await setup(d);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ft-'));
  const mk = () => freeTierPipeline({ workerUrl: ORIGIN, ingestSecret: env.INGEST_SECRET, closedWeek: d.week.weekStart,
    verifyUrl: 'https://site.test/.netlify/functions/gp-verify-background', triggerSecret: TRIGGER, fetchImpl, sleep: async () => {} });
  // First run: the report is the first version → held for review; no week can be computed yet (exact code).
  const r1 = await run(d, mk(), dir);
  assert.equal(r1.compute.status, 'partial');
  assert.ok(r1.compute.weeks.every(w => w.status === 'pending' && w.code === 'shipping_report_not_ready'), JSON.stringify(r1.compute.weeks));
  const v = (await api(env, 'GET', '/v1/admin/scr/versions')).json.versions[0];
  assert.deepEqual(v.reviewReasons, ['first_version']);
  await ok(api(env, 'POST', `/v1/admin/scr/versions/${v.versionId}/accept`, { reason: 'test: first version reviewed' }), 'accept');
  // Second run: sources already held (nothing re-collected); every week computed and verified.
  const r2 = await run(d, mk(), dir);
  assert.equal(r2.status, 'already_collected');
  const ft = mk();
  const r3 = await ft.compute();
  assert.equal(r3.status, "ok", JSON.stringify(r3.weeks));
  assert.equal(r3.weeks.length, d.weeks.length);
  assert.ok(r3.weeks.every(w => w.status === 'computed' && w.verification === 'verified'));
  // Logs of the verifier: counts only.
  assert.ok(logs.length >= 1, "one counts-only log line per verifier run");
  for (const l of logs) { const j = JSON.parse(l); assert.ok(!('diff' in j) && !JSON.stringify(j).includes('#7')); }
  // Third time: nothing changed → nothing computed, nothing written.
  const r4 = await mk().compute();
  assert.ok(r4.weeks.every(w => w.status === 'unchanged'), JSON.stringify(r4.weeks));
  const status = (await api(env, 'GET', `/v1/weeks/${d.week.weekStart}/status`)).json;
  assert.equal(status.state, 'verified');
});
