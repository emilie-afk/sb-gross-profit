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
import { runWeeklyCollection, EXIT } from '../automation/collector/src/orchestrate.mjs';
import { freeTierPipeline, publicationOutcome } from '../automation/collector/src/freeTier.mjs';
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

test('collector on the Free-tier path: collect → upload → compute every week → verified; a second run collects nothing and computes what the review unblocked', { timeout: 300_000 }, async () => {
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
  assert.deepEqual(v.reviewReasons, ['first_version', 'auto_acceptance_disabled']);
  await ok(api(env, 'POST', `/v1/admin/scr/versions/${v.versionId}/accept`, { reason: 'test: first version reviewed' }), 'accept');
  // Second run: sources already held (nothing re-collected), but the run still computes: every
  // week computed and verified (before, the restart returned at once and the weeks stayed uncomputed).
  const r2 = await run(d, mk(), dir);
  assert.equal(r2.status, 'already_collected', JSON.stringify(r2.compute).slice(0, 600));
  const r3 = r2.compute;
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

test('collector, automatic mode: the report is accepted without a person, every week verified, and eligible weeks published in order once enabled', { timeout: 300_000 }, async () => {
  const d = dataset({ n: 150, scr: { zeroEvery: 1e9 } });
  const { env, fetchImpl } = await setup(d);
  for (const [k, v] of [['shipping_cost_auto_accept_enabled', true], ['shipping_cost_auto_accept_rules', 'flag_and_accept']]) await ok(api(env, 'POST', '/v1/admin/settings', { [k]: v, reason: `test: ${k}` }), k);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ft-'));
  const mk = () => freeTierPipeline({ workerUrl: ORIGIN, ingestSecret: env.INGEST_SECRET, closedWeek: d.week.weekStart,
    verifyUrl: 'https://site.test/.netlify/functions/gp-verify-background', triggerSecret: TRIGGER, fetchImpl, sleep: async () => {} });
  const r1 = await run(d, mk(), dir);
  assert.equal(r1.compute.status, 'ok', JSON.stringify(r1.compute.weeks));
  assert.ok(r1.compute.weeks.every(w => w.status === 'computed' && w.verification === 'verified'), 'no review step: computed and verified in the first run');
  assert.ok(r1.compute.publication.length >= 1 && r1.compute.publication.every(p => !p.published), 'nothing is published while the controls are off');
  assert.ok(r1.compute.publication.every(p => p.outcome === 'held'), 'switched off is an intentional hold, not a failure');
  assert.equal(r1.exitCode, EXIT.OK, 'a hold does not make the run partial');
  // Approval: the pinned catalogs accepted, provisional publication and both go-live locks on, weeks from W2 eligible.
  for (const w of d.weeks) {
    const rev = (await env.DB.prepare('SELECT catalog_rev FROM snapshot WHERE week_start = ?1 ORDER BY revision DESC LIMIT 1').bind(w).first()).catalog_rev;
    await ok(api(env, 'POST', `/v1/admin/weeks/${w}/accept-pinned-catalog`, { catalogRev: rev, reason: 'test: pinned catalog is right for this period' }), 'pinned');
  }
  for (const [k, v] of [['provisional_publication_enabled', true], ['publication_enabled', true], ['ss_coverage_threshold', 0.5]]) await ok(api(env, 'POST', '/v1/admin/settings', { [k]: v, reason: `test: approved ${k}` }), k);
  env.PUBLICATION_ALLOWED = 'true'; env.PUBLICATION_EARLIEST_WEEK = d.weeks[2];
  const r2 = await mk().compute();
  assert.equal(r2.status, 'ok', JSON.stringify(r2.weeks));
  const by = Object.fromEntries(r2.publication.map(p => [p.weekStart, p]));
  assert.deepEqual([by[d.weeks[0]].reason, by[d.weeks[1]].reason], ['costs_not_period_accurate', 'costs_not_period_accurate']);
  assert.ok(d.weeks.slice(2).every(w => by[w]?.published === true), JSON.stringify(r2.publication));
  const visible = (await api(env, 'GET', '/v1/weeks')).json.weeks.map(w => w.weekStart).sort();
  assert.deepEqual(visible, d.weeks.slice(2));
  // Next run with nothing new: nothing recomputed, nothing published twice.
  const r3 = await mk().compute();
  assert.ok(r3.weeks.every(w => w.status === 'unchanged'), JSON.stringify(r3.weeks));
  assert.ok(r3.publication.filter(p => p.published).every(p => p.alreadyPublished === true));
});

test('collector: a publication that fails for a retryable reason keeps the run partial (the week is retried), then publishes', { timeout: 300_000 }, async () => {
  const d = dataset({ n: 150, scr: { zeroEvery: 1e9 } });
  const { env, fetchImpl: base } = await setup(d);
  for (const [k, v] of [['shipping_cost_auto_accept_enabled', true], ['shipping_cost_auto_accept_rules', 'flag_and_accept']]) await ok(api(env, 'POST', '/v1/admin/settings', { [k]: v, reason: `test: ${k}` }), k);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ft-'));
  // The Worker's publish route fails (503) until `healthy` — a transient outage during the run.
  let healthy = false, failures = 0;
  const fetchImpl = async (url, init) => {
    if (!healthy && /\/v1\/collect\/weeks\/[\d-]+\/publish$/.test(url)) { failures++; return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 }); }
    return base(url, init);
  };
  const mk = () => freeTierPipeline({ workerUrl: ORIGIN, ingestSecret: env.INGEST_SECRET, closedWeek: d.week.weekStart,
    verifyUrl: 'https://site.test/.netlify/functions/gp-verify-background', triggerSecret: TRIGGER, fetchImpl, sleep: async () => {} });
  await run(d, mk(), dir);
  for (const w of d.weeks) {
    const rev = (await env.DB.prepare('SELECT catalog_rev FROM snapshot WHERE week_start = ?1 ORDER BY revision DESC LIMIT 1').bind(w).first()).catalog_rev;
    await ok(api(env, 'POST', `/v1/admin/weeks/${w}/accept-pinned-catalog`, { catalogRev: rev, reason: 'test: pinned catalog is right for this period' }), 'pinned');
  }
  for (const [k, v] of [['provisional_publication_enabled', true], ['publication_enabled', true], ['ss_coverage_threshold', 0.5]]) await ok(api(env, 'POST', '/v1/admin/settings', { [k]: v, reason: `test: approved ${k}` }), k);
  env.PUBLICATION_ALLOWED = 'true';
  // The attempt during the outage: every week computed and verified, but publication failed → partial (exit 40), so no "done".
  const r2 = await run(d, mk(), dir);
  assert.ok(failures > 0);
  assert.equal(r2.compute.status, 'partial', JSON.stringify(r2.compute.publication));
  assert.equal(r2.exitCode, EXIT.PARTIAL, 'the Windows task retries a partial run and does not mark the week done');
  assert.ok(r2.compute.publication.some(p => p.outcome === 'retry'));
  assert.ok(r2.compute.weeks.every(w => w.status === 'unchanged' || w.verification === 'verified'));
  // The retry after the outage publishes every eligible week and the run is ok.
  healthy = true;
  const r3 = await run(d, mk(), dir);
  assert.equal(r3.exitCode, EXIT.OK, JSON.stringify(r3.compute.publication));
  assert.ok(r3.compute.publication.every(p => p.outcome === 'published' || p.outcome === 'already_published'));
  assert.deepEqual((await api(env, 'GET', '/v1/weeks')).json.weeks.map(w => w.weekStart).sort(), [...d.weeks].sort());
});

test('collector: publication outcomes — intentional holds versus retryable failures', () => {
  const o = reason => publicationOutcome({ published: false, reason });
  for (const r of ['publication_disabled', 'publication_not_allowed_in_environment', 'carrier_fee_priority_unlocked', 'costs_not_period_accurate', 'gate_failed', 'shipping_source_unverified', 'publish_route_unavailable'])
    assert.equal(o(r), 'held', r);
  for (const r of ['publish_failed', 'http_503', 'comparison_stale', 'verification_pending', 'verification_unavailable', 'verification_gate_unchecked',
                   'shipping_report_newer_pending', 'shipping_report_basis_changed', 'not_latest_revision', 'inputs_changed', 'something_new'])
    assert.equal(o(r), 'retry', r);
  assert.equal(publicationOutcome({ published: true }), 'published');
  assert.equal(publicationOutcome({ published: true, alreadyPublished: true }), 'already_published');
});
