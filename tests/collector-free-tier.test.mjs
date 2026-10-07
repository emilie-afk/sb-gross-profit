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
import { freeTierPipeline, publicationOutcome, computeAndUploadWeek, collectClient, newCache, uploadShopifyOrders, uploadShippingCostReport, drainPendingVerifications, requestVerification } from '../automation/collector/src/freeTier.mjs';
import gpVerify from '../netlify/functions/gp-verify-background.mjs';
import { dataset, freeTierEnv, api, ok, bridge, ORIGIN, TRIGGER } from '../worker/test/freeTierHarness.mjs';
import { scrRows } from './fixtures-free-tier.mjs';
import { toCsvText } from '../shared/adapters/shopifyCsv.js';
import { sanitizeShippingCostReport, parseShippingCostReport } from '../shared/adapters/shippingCostReport.js';
import { addDays } from '../shared/normalized.js';

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

function run(d, ft, dir, { collectedReport = true, counts = null, plan = null } = {}) {
  return runWeeklyCollection({
    week: { weekStart: d.week.weekStart, weekEnd: d.week.weekEnd, closed: true },
    lockFile: path.join(dir, 'lock'), stateFile: path.join(dir, 'state.json'),
    weekPlan: () => (plan ? plan() : ft.weekPlan()),
    shipstation: {
      collect: async () => { if (counts) counts.shipstation++; return { status: 'prepared', exitCode: 0, pending: { payload: d.scr } }; },
      upload: async p => { const r = await ft.uploadImpl({ path: '/v1/ingest/shipping-cost-report', payload: p.payload }); return { status: r.ok ? 'ok' : 'upload_failed', exitCode: r.ok ? 0 : 31, r }; },
    },
    shopify: { run: async ({ onWaiting }) => { if (counts) counts.shopify++; await onWaiting(); const r = await ft.uploadImpl({ path: '/v1/ingest/shopify', payload: d.shopify }); return { status: r.ok ? 'ok' : 'upload_failed', exitCode: r.ok ? 0 : 32 }; } },
    compute: () => ft.compute(),
    budget: () => ft.budget(),                                       // as run.mjs wires it
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

test('collector: unfinished verification is recovered on the next run although the inputs are unchanged', { timeout: 300_000 }, async () => {
  const d = dataset({ n: 150, scr: { zeroEvery: 1e9 } });
  const { env, fetchImpl } = await setup(d);
  for (const [k, v] of [['shipping_cost_auto_accept_enabled', true], ['shipping_cost_auto_accept_rules', 'flag_and_accept']]) await ok(api(env, 'POST', '/v1/admin/settings', { [k]: v, reason: `test: ${k}` }), k);
  // A run stopped after computing: every week has a draft, none was verified.
  const c = collectClient({ workerUrl: ORIGIN, ingestSecret: env.INGEST_SECRET, fetchImpl, sleep: async () => {} });
  await uploadShippingCostReport(c, d.scr);
  const orders = await uploadShopifyOrders(c, d.shopify);
  const cache = newCache(orders.bodies);
  for (const w of d.weeks) assert.equal((await computeAndUploadWeek(c, w, cache)).status, 'computed');
  // An earlier week outside the next run's window also has an unverified newest draft (and an older one that must be ignored).
  const unverified = async () => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM snapshot s LEFT JOIN verify_report v ON v.snapshot_id = s.snapshot_id
      WHERE s.storage = 'chunked' AND v.status IS NULL AND NOT EXISTS (SELECT 1 FROM snapshot n WHERE n.week_start = s.week_start AND n.revision > s.revision)`).first()).n;
  assert.equal(await unverified(), d.weeks.length);
  const pending = (await api(env, 'GET', '/v1/collect/verification/pending', undefined, 'ingest')).json.pending;
  assert.equal(pending.length, d.weeks.length, 'the Worker lists the newest unverified revision of each week');
  // Verifier unreachable: the run cannot finish the verification, so it stays partial (no done marker).
  const down = (url, init) => (url.startsWith('https://site.test/') ? Promise.resolve(new Response('', { status: 503 })) : fetchImpl(url, init));
  const mk = (f, closedWeek = d.week.weekStart) => freeTierPipeline({ workerUrl: ORIGIN, ingestSecret: env.INGEST_SECRET, closedWeek,
    verifyUrl: 'https://site.test/.netlify/functions/gp-verify-background', triggerSecret: TRIGGER, fetchImpl: f, sleep: async () => {} });
  const r0 = await mk(down).compute();
  assert.equal(r0.status, 'partial');
  assert.ok(r0.weeks.every(w => w.status === 'unchanged' && w.verificationRecovered && w.verification === 'verifier_unreachable'), JSON.stringify(r0.weeks));
  // The next run, inputs still unchanged and window ending one week earlier: every week verified, including the
  // one outside the window (recovered from the Worker's list), with nothing recomputed.
  // The shifted window starts one week before the data's coverage; that week alone stays pending (no report yet).
  const r1 = await mk(fetchImpl, d.weeks[d.weeks.length - 2]).compute();
  const [early, ...inData] = r1.weeks;
  assert.ok(early.weekStart < d.weeks[0] && early.status === 'pending' && early.code === 'shipping_report_not_ready', JSON.stringify(early));
  assert.equal(r1.status, 'partial', 'only the uncovered window-start week keeps the run partial');
  assert.ok(inData.length && inData.every(w => w.status === 'unchanged' && w.verificationRecovered && w.verification === 'verified'), JSON.stringify(inData));
  assert.deepEqual(r1.otherWeeks.map(w => [w.weekStart, w.verification]), [[d.weeks[d.weeks.length - 1], 'verified']]);
  assert.equal(await unverified(), 0);
  assert.equal((await api(env, 'GET', '/v1/collect/verification/pending', undefined, 'ingest')).json.pending.length, 0);
  // Nothing left: a further run requests no verification and is ok.
  const r2 = await mk(fetchImpl).compute();
  assert.equal(r2.status, 'ok');
  assert.ok(r2.weeks.every(w => !w.verificationRecovered));
});

/** A later Shipping Cost Report for one week's dates only, with every cost shifted (a cost restatement). */
function restatedReport(d, weekStart, costShift, exportedAt) {
  const lastDay = addDays(weekStart, 6);
  const sr = sanitizeShippingCostReport(scrRows(d.meta.filter(o => o.day >= weekStart && o.day <= lastDay), { lastDay, costShift, zeroEvery: 1e9, extraUnmatched: 0 }));
  const p = parseShippingCostReport(sr.rows, { requestedFrom: weekStart, requestedTo: lastDay });
  return { format: 'csv_text', text: toCsvText(sr.rows, sr.columns), requestedFrom: weekStart, requestedTo: lastDay, rowCount: p.rowCount,
           shippingCostTotal: p.shippingCostCents / 100, exportedAt };
}

test('collector: a new revision of an earlier published week brings every dependent comparison up to date in the same run', { timeout: 300_000 }, async () => {
  const d = dataset({ n: 150, scr: { zeroEvery: 1e9 } });
  const { env, fetchImpl } = await setup(d);
  for (const [k, v] of [['shipping_cost_auto_accept_enabled', true], ['shipping_cost_auto_accept_rules', 'flag_and_accept']]) await ok(api(env, 'POST', '/v1/admin/settings', { [k]: v, reason: `test: ${k}` }), k);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ft-'));
  const mk = (closedWeek = d.week.weekStart) => freeTierPipeline({ workerUrl: ORIGIN, ingestSecret: env.INGEST_SECRET, closedWeek,
    verifyUrl: 'https://site.test/.netlify/functions/gp-verify-background', triggerSecret: TRIGGER, fetchImpl, sleep: async () => {} });
  const r0 = await run(d, mk(), dir);
  assert.equal(r0.exitCode, EXIT.OK, JSON.stringify(r0));
  for (const w of d.weeks) {
    const rev = (await env.DB.prepare('SELECT catalog_rev FROM snapshot WHERE week_start = ?1 ORDER BY revision DESC LIMIT 1').bind(w).first()).catalog_rev;
    await ok(api(env, 'POST', `/v1/admin/weeks/${w}/accept-pinned-catalog`, { catalogRev: rev, reason: 'test: pinned catalog is right for this period' }), 'pinned');
  }
  for (const [k, v] of [['provisional_publication_enabled', true], ['publication_enabled', true], ['ss_coverage_threshold', 0.5]]) await ok(api(env, 'POST', '/v1/admin/settings', { [k]: v, reason: `test: approved ${k}` }), k);
  env.PUBLICATION_ALLOWED = 'true';
  assert.equal((await mk().compute()).status, 'ok');
  const published = async () => Object.fromEntries((await env.DB.prepare("SELECT week_start, snapshot_id, revision, comparison_snapshot_id FROM snapshot WHERE status = 'published'").all()).results.map(x => [x.week_start, x]));
  const current = pub => d.weeks.every((w, i) => pub[w] && (pub[w].comparison_snapshot_id || null) === (i ? pub[d.weeks[i - 1]].snapshot_id : null));
  const before = await published();
  assert.ok(current(before), 'every week published, each compared with the prior published week');

  // The next weekly collector run (a newly closed week: both sources are exported once): the report restates the first week's costs.
  // That week gets a new published revision, and every later published week is recomputed from stored inputs,
  // verified and republished against it — in the same run, with no further export.
  const counts = { shipstation: 0, shopify: 0 };
  const restated = { ...d, scr: restatedReport(d, d.weeks[0], 0.25, `${addDays(d.win.to, 2)}T15:00:00Z`) };
  const r = await run(restated, mk(), fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ft-')), { counts, plan: async () => ({ collected: {} }) });
  assert.equal(r.exitCode, EXIT.OK, JSON.stringify(r.compute.publication));
  assert.deepEqual(counts, { shipstation: 1, shopify: 1 }, 'one export of each source');
  const after = await published();
  assert.ok(current(after), 'every comparison is with the prior published week after one run');
  assert.ok(d.weeks.every(w => after[w].snapshot_id !== before[w].snapshot_id && after[w].revision > before[w].revision), 'every dependent week republished');
  // Only the comparison moved: the dependent weeks' figures are the same as before.
  const figures = async id => { const x = await env.DB.prepare('SELECT * FROM snapshot_totals WHERE snapshot_id = ?1').bind(id).first(); delete x.snapshot_id; return x; };
  for (const w of d.weeks.slice(1)) assert.deepEqual(await figures(after[w].snapshot_id), await figures(before[w].snapshot_id), `${w} figures unchanged`);
  assert.notDeepEqual(await figures(after[d.weeks[0]].snapshot_id), await figures(before[d.weeks[0]].snapshot_id), 'the restated week changed');
  const by = Object.fromEntries(r.compute.publication.map(p => [p.weekStart, p]));
  assert.ok(d.weeks.slice(1).every(w => by[w].published && by[w].comparisonRefreshed), JSON.stringify(r.compute.publication));
  assert.deepEqual(r.compute.publication.map(p => p.weekStart), [...d.weeks], 'oldest week first');
  const superseded = (await env.DB.prepare("SELECT COUNT(*) AS n FROM snapshot WHERE status = 'superseded'").first()).n;
  assert.equal(superseded, d.weeks.length, 'earlier published revisions are kept as superseded');

  // Dependents outside the window: a run whose window ends at the first week still finishes the chain.
  const again = await (async () => {
    const c = collectClient({ workerUrl: ORIGIN, ingestSecret: env.INGEST_SECRET, fetchImpl, sleep: async () => {} });
    await uploadShippingCostReport(c, restatedReport(d, d.weeks[0], 0.5, `${addDays(d.win.to, 3)}T15:00:00Z`));
    return mk(d.weeks[0]).compute();
  })();
  // That window holds the first week and weeks before the data (no report yet: pending, which keeps the run partial).
  const [first, ...rest] = [...again.weeks].reverse();
  assert.deepEqual([first.weekStart, first.status, first.verification], [d.weeks[0], 'computed', 'verified']);
  assert.ok(rest.every(w => w.weekStart < d.weeks[0] && w.status === 'pending'), JSON.stringify(rest));
  assert.ok(again.publication.every(p => p.published), JSON.stringify(again.publication));
  assert.ok(again.publication.slice(1).every(p => p.dependent && p.comparisonRefreshed));
  assert.deepEqual(again.dependentWeeks.map(w => [w.weekStart, w.verification]), d.weeks.slice(1).map(w => [w, 'verified']));
  assert.ok(current(await published()));

  // Nothing new: nothing recomputed, nothing republished.
  const quiet = await mk().compute();
  assert.equal(quiet.status, 'ok');
  assert.ok(quiet.weeks.every(w => w.status === 'unchanged'), JSON.stringify(quiet.weeks));
  assert.ok(quiet.publication.every(p => p.alreadyPublished && !p.comparisonRefreshed));
});

test('collector: a failed backlog lookup keeps the run partial; only an explicit 404 (older Worker) falls back', { timeout: 300_000 }, async () => {
  const d = dataset({ n: 150, scr: { zeroEvery: 1e9 } });
  const { env, fetchImpl } = await setup(d);
  for (const [k, v] of [['shipping_cost_auto_accept_enabled', true], ['shipping_cost_auto_accept_rules', 'flag_and_accept']]) await ok(api(env, 'POST', '/v1/admin/settings', { [k]: v, reason: `test: ${k}` }), k);
  let mode = 'up';
  const f = (url, init) => {
    if (/\/v1\/collect\/verification\/pending/.test(url)) {
      if (mode === 'down') return Promise.resolve(new Response(JSON.stringify({ error: 'internal_error' }), { status: 500 }));
      if (mode === 'quota') return Promise.resolve(new Response(JSON.stringify({ error: 'd1_daily_limit_reached' }), { status: 503 }));
      if (mode === 'network') return Promise.reject(new TypeError('fetch failed'));
      if (mode === 'old') return Promise.resolve(new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }));
    }
    return fetchImpl(url, init);
  };
  const mk = () => freeTierPipeline({ workerUrl: ORIGIN, ingestSecret: env.INGEST_SECRET, closedWeek: d.week.weekStart,
    verifyUrl: 'https://site.test/.netlify/functions/gp-verify-background', triggerSecret: TRIGGER, fetchImpl: f, sleep: async () => {} });
  const first = await run(d, mk(), fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ft-')));
  assert.equal(first.compute.status, 'ok', 'every week computed and verified: nothing else makes the next runs partial');
  for (const m of ['down', 'network']) {
    mode = m;
    const r = await mk().compute();
    assert.ok(r.weeks.every(w => w.status === 'unchanged'), m);
    assert.equal(r.verificationBacklog.status, 'failed', m);
    assert.equal(r.status, 'partial', `${m}: an unreadable backlog is not an empty backlog`);
  }
  // D1's daily limit on that call: the run is deferred (not ok, not retried soon), never complete.
  mode = 'quota';
  const q = await mk().compute();
  assert.deepEqual([q.status, q.code], ['deferred', 'd1_daily_limit_reached']);
  mode = 'old';
  const old = await mk().compute();
  assert.deepEqual([old.status, old.verificationBacklog.status], ['ok', 'unsupported']);
  mode = 'up';
  const up = await mk().compute();
  assert.deepEqual([up.status, up.verificationBacklog], ['ok', undefined]);
});

test('collector: a backlog of more than 20 unverified drafts is drained page by page and all of it is requested', async () => {
  const env = await freeTierEnv();
  const { ENGINE_VERSION } = await import('../shared/snapshot.js');
  const weeks = Array.from({ length: 27 }, (_, i) => addDays('2026-01-05', 7 * i));
  const ins = env.DB.db.prepare("INSERT INTO snapshot (snapshot_id, week_start, revision, status, computed_at, engine_version, policy, profitability_status, storage) VALUES (?, ?, ?, 'draft', 't', ?, '{}', 'ok', 'chunked')");
  weeks.forEach((w, i) => {
    ins.run(`snp_old${String(i).padStart(16, '0')}`, w, 1, ENGINE_VERSION);                       // an older revision is never listed
    ins.run(`snp_new${String(i).padStart(16, '0')}`, w, 2, i === 26 ? 'engine-before' : ENGINE_VERSION);
  });
  const p1 = (await api(env, 'GET', '/v1/collect/verification/pending?limit=20', undefined, 'ingest')).json;
  assert.equal(p1.pending.length, 20);
  assert.equal(p1.next, weeks[19]);
  const p2 = (await api(env, 'GET', `/v1/collect/verification/pending?limit=20&after=${p1.next}`, undefined, 'ingest')).json;
  assert.deepEqual([p2.pending.length, p2.otherEngine, p2.next], [6, 1, null]);
  const c = collectClient({ workerUrl: ORIGIN, ingestSecret: env.INGEST_SECRET, fetchImpl: bridge(env), sleep: async () => {} });
  const all = await drainPendingVerifications(c, { pageSize: 20 });
  assert.deepEqual([all.status, all.pending.length, all.otherEngine], ['ok', 26, 1]);
  assert.ok(all.pending.every(p => p.revision === 2));
  const capped = await drainPendingVerifications(c, { pageSize: 20, maxPages: 1 });
  assert.equal(capped.status, 'truncated', 'a cap leaves work: the run stays partial');
  // Every drained draft is sent to the verifier, in requests of at most 20.
  const posts = [];
  const vf = async (url, init) => { posts.push(JSON.parse(init.body).snapshotIds.length); return new Response('', { status: 202 }); };
  const out = await requestVerification({ verifyUrl: 'https://site.test/v', triggerSecret: TRIGGER, snapshots: all.pending, client: c, fetchImpl: vf, waitMs: 0, sleep: async () => {} });
  assert.deepEqual(posts, [20, 6]);
  assert.equal(out.length, 26);
});

test('collector: a failed publication of a dependent week outside the window keeps the run partial and resumes on retry', { timeout: 300_000 }, async () => {
  const d = dataset({ n: 150, scr: { zeroEvery: 1e9 } });
  const { env, fetchImpl: base } = await setup(d);
  env.REPORTING_START_DATE = d.weeks[0];                       // weeks before the data are not reported (not a failure)
  for (const [k, v] of [['shipping_cost_auto_accept_enabled', true], ['shipping_cost_auto_accept_rules', 'flag_and_accept']]) await ok(api(env, 'POST', '/v1/admin/settings', { [k]: v, reason: `test: ${k}` }), k);
  let failing = null, publishCalls = 0;
  const fetchImpl = async (url, init) => {
    if (failing && url.endsWith(`/v1/collect/weeks/${failing}/publish`)) { publishCalls++; return new Response(JSON.stringify({ error: 'internal_error' }), { status: 500 }); }
    return base(url, init);
  };
  const mk = (closedWeek = d.week.weekStart) => freeTierPipeline({ workerUrl: ORIGIN, ingestSecret: env.INGEST_SECRET, closedWeek,
    verifyUrl: 'https://site.test/.netlify/functions/gp-verify-background', triggerSecret: TRIGGER, fetchImpl, sleep: async () => {} });
  await run(d, mk(), fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ft-')));
  for (const w of d.weeks) {
    const rev = (await env.DB.prepare('SELECT catalog_rev FROM snapshot WHERE week_start = ?1 ORDER BY revision DESC LIMIT 1').bind(w).first()).catalog_rev;
    await ok(api(env, 'POST', `/v1/admin/weeks/${w}/accept-pinned-catalog`, { catalogRev: rev, reason: 'test: pinned catalog is right for this period' }), 'pinned');
  }
  for (const [k, v] of [['provisional_publication_enabled', true], ['publication_enabled', true], ['ss_coverage_threshold', 0.5]]) await ok(api(env, 'POST', '/v1/admin/settings', { [k]: v, reason: `test: approved ${k}` }), k);
  env.PUBLICATION_ALLOWED = 'true';
  { const r0 = await mk().compute(); assert.equal(r0.status, 'ok', JSON.stringify({ w: r0.weeks, p: r0.publication, b: r0.publicationBacklog })); }
  const published = async () => Object.fromEntries((await env.DB.prepare("SELECT week_start, snapshot_id, comparison_snapshot_id FROM snapshot WHERE status = 'published'").all()).results.map(x => [x.week_start, x]));
  const current = pub => d.weeks.every((w, i) => pub[w] && (pub[w].comparison_snapshot_id || null) === (i ? pub[d.weeks[i - 1]].snapshot_id : null));
  const before = await published();
  // The first week's costs are restated; the run's window ends at that week. The fourth week's publication fails.
  const c = collectClient({ workerUrl: ORIGIN, ingestSecret: env.INGEST_SECRET, fetchImpl: base, sleep: async () => {} });
  await uploadShippingCostReport(c, restatedReport(d, d.weeks[0], 0.25, `${addDays(d.win.to, 2)}T15:00:00Z`));
  failing = d.weeks[3];
  const r1 = await mk(d.weeks[0]).compute();
  assert.ok(publishCalls > 0);
  assert.equal(r1.status, 'partial', JSON.stringify(r1.publication));
  const f = r1.publication.find(p => p.weekStart === failing);
  assert.deepEqual([f.published, f.outcome, f.dependent], [false, 'retry', true], 'the failure is recorded, not dropped');
  const mid = await published();
  assert.ok([1, 2].every(i => mid[d.weeks[i]].snapshot_id !== before[d.weeks[i]].snapshot_id), 'the chain ran up to the failure');
  assert.ok(d.weeks.slice(3).every(w => mid[w].snapshot_id === before[w].snapshot_id), 'nothing after it was published');
  const listed = (await api(env, 'GET', '/v1/collect/publication/pending', undefined, 'ingest')).json.weeks;
  assert.deepEqual(listed.map(x => [x.weekStart, x.reason]), [[failing, 'comparison_stale']], 'the Worker keeps the unfinished link');
  // The retry (no export, same window) resumes the chain at the failed week, oldest first, and finishes it.
  failing = null;
  const r2 = await mk(d.weeks[0]).compute();
  assert.equal(r2.status, 'ok', JSON.stringify(r2.publication));
  assert.equal(r2.publication[0].weekStart, d.weeks[0]);
  assert.deepEqual(r2.publication.filter(p => p.comparisonRefreshed).map(p => p.weekStart), d.weeks.slice(3));
  assert.ok(r2.publication.find(p => p.weekStart === d.weeks[3]).resumed);
  assert.ok(current(await published()));
  assert.deepEqual((await api(env, 'GET', '/v1/collect/publication/pending', undefined, 'ingest')).json.weeks, []);
  // Nothing left: a further run does no publication work.
  const r3 = await mk(d.weeks[0]).compute();
  assert.equal(r3.status, 'ok');
  assert.ok(!r3.publication.some(p => p.comparisonRefreshed || p.resumed));
});

test('collector: a used-up D1 budget defers the run (exit 42): no export at the start, a stop mid-run, never retried soon, never done', { timeout: 300_000 }, async () => {
  const d = dataset({ n: 150, scr: { zeroEvery: 1e9 } });
  const { env, fetchImpl: base } = await setup(d);
  for (const [k, v] of [['shipping_cost_auto_accept_enabled', true], ['shipping_cost_auto_accept_rules', 'flag_and_accept']]) await ok(api(env, 'POST', '/v1/admin/settings', { [k]: v, reason: `test: ${k}` }), k);
  const { _resetBudgetCache } = await import('../worker/src/usage.js');
  const use = (read) => env.DB.prepare(`INSERT INTO d1_usage (day, scope, rows_read, rows_written, requests) VALUES (?1, 'dashboard', ?2, 0, 1)
    ON CONFLICT(day, scope) DO UPDATE SET rows_read = excluded.rows_read`).bind(new Date().toISOString().slice(0, 10), read).run();
  let manifests = 0, gateAfter = Infinity;
  const fetchImpl = async (url, init) => {
    if (/\/manifest$/.test(url) && ++manifests > gateAfter) { await use(4_000_000); _resetBudgetCache(); }
    return base(url, init);
  };
  const mk = () => freeTierPipeline({ workerUrl: ORIGIN, ingestSecret: env.INGEST_SECRET, closedWeek: d.week.weekStart,
    verifyUrl: 'https://site.test/.netlify/functions/gp-verify-background', triggerSecret: TRIGGER, fetchImpl, sleep: async () => {} });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ft-'));
  const counts = { shipstation: 0, shopify: 0 };
  // 1. Over budget before the run: nothing is exported or computed, exit 42, no state recorded as collected.
  await use(3_500_000); _resetBudgetCache();
  const a = await run(d, mk(), dir, { counts });
  assert.deepEqual([a.status, a.exitCode, counts], ['deferred', EXIT.DEFERRED, { shipstation: 0, shopify: 0 }]);
  assert.match(a.resumeAfter, /T00:00:00\.000Z$/);
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false);
  // 2. Within budget at the start, used up after the third week's manifest: the sources received are kept,
  //    the compute stops at once (no retries of the refused call), and the run is deferred, not partial or ok.
  await use(0); _resetBudgetCache(); gateAfter = 3;
  const b = await run(d, mk(), dir, { counts });
  assert.deepEqual([b.status, b.exitCode], ['deferred', EXIT.DEFERRED], JSON.stringify(b.compute));
  assert.deepEqual(counts, { shipstation: 1, shopify: 1 }, 'sources exported once and kept');
  assert.equal(b.compute.code, 'background_deferred');
  assert.ok(manifests <= 5, `stopped after the refusal (${manifests} manifest calls)`);
  const computed = (await env.DB.prepare('SELECT COUNT(DISTINCT week_start) AS n FROM snapshot').first()).n;
  assert.ok(computed >= 1 && computed < d.weeks.length, 'progress kept, rest deferred');
  // 3. After the reset: the next start resumes without exporting again and finishes.
  await env.DB.prepare('DELETE FROM d1_usage').run(); _resetBudgetCache(); gateAfter = Infinity;
  const c = await run(d, mk(), dir, { counts });
  assert.equal(c.exitCode, EXIT.OK, JSON.stringify(c.compute?.weeks));
  assert.deepEqual(counts, { shipstation: 1, shopify: 1 }, 'nothing exported twice');
});

test('collector: the Worker client never retries a deferral answer', async () => {
  let calls = 0;
  const f = async () => { calls++; return new Response(JSON.stringify({ error: 'd1_daily_limit_reached', detail: { resetAt: '2026-10-07T00:00:00.000Z' } }), { status: 503 }); };
  const c = collectClient({ workerUrl: ORIGIN, ingestSecret: 'x'.repeat(32), fetchImpl: f, sleep: async () => {} });
  await assert.rejects(c.call('GET', '/v1/collect/budget'), e => e.code === 'd1_daily_limit_reached' && !!e.detail.resetAt);
  assert.equal(calls, 1);
  let other = 0;
  const g = async () => { other++; return new Response(JSON.stringify({ error: 'internal_error' }), { status: 500 }); };
  await assert.rejects(collectClient({ workerUrl: ORIGIN, ingestSecret: 'x'.repeat(32), fetchImpl: g, sleep: async () => {} }).call('GET', '/v1/collect/budget'));
  assert.equal(other, 4, 'an ordinary 500 is still retried');
});

test('cost correction: named weeks get corrected, verified, published revisions on their own catalog plus the MCG table; later weeks keep their newer catalog', { timeout: 300_000 }, async () => {
  const d = dataset({ n: 150, scr: { zeroEvery: 1e9 } });
  const old = dataset({ n: 120, lastWeek: addDays(d.week.weekStart, -56), prefix: '6', scr: { zeroEvery: 1e9 } });   // the 8 weeks before the window
  const { env, fetchImpl } = await setup(d);                   // catalog 1 (d.catalog)
  env.REPORTING_START_DATE = old.weeks[0];
  for (const [k, v] of [['shipping_cost_auto_accept_enabled', true], ['shipping_cost_auto_accept_rules', 'flag_and_accept']]) await ok(api(env, 'POST', '/v1/admin/settings', { [k]: v, reason: `test: ${k}` }), k);
  const mk = (closedWeek = d.week.weekStart) => freeTierPipeline({ workerUrl: ORIGIN, ingestSecret: env.INGEST_SECRET, closedWeek,
    verifyUrl: 'https://site.test/.netlify/functions/gp-verify-background', triggerSecret: TRIGGER, fetchImpl, sleep: async () => {} });
  const push = async c => (await ok(api(env, 'POST', '/v1/ingest/catalog', c, 'ingest'), 'catalog')).catalogRev;
  // The older weeks are computed on catalog 1; then a newer catalog (an unrelated cost update) is accepted
  // and the recent weeks are computed on it.
  await run(old, mk(old.week.weekStart), fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ft-')));
  const rev1 = (await env.DB.prepare('SELECT catalog_rev FROM snapshot LIMIT 1').first()).catalog_rev;
  const newer = structuredClone(d.catalog); newer.tables.hp_supplement = { ...newer.tables.hp_supplement, 'MG-JADE': 6.5 };
  const revNew = await push(newer);
  await run(d, mk(), fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ft-')));
  const weeks = [...old.weeks, ...d.weeks];
  const catOf = async w => (await env.DB.prepare('SELECT catalog_rev FROM snapshot WHERE week_start = ?1 ORDER BY revision DESC LIMIT 1').bind(w).first()).catalog_rev;
  assert.equal(await catOf(old.weeks[3]), rev1);
  assert.equal(await catOf(d.weeks[3]), revNew);
  for (const w of weeks) await ok(api(env, 'POST', `/v1/admin/weeks/${w}/accept-pinned-catalog`, { catalogRev: await catOf(w), reason: 'test: pinned catalog is right for this period' }), 'pinned');
  for (const [k, v] of [['provisional_publication_enabled', true], ['publication_enabled', true], ['ss_coverage_threshold', 0.5]]) await ok(api(env, 'POST', '/v1/admin/settings', { [k]: v, reason: `test: approved ${k}` }), k);
  env.PUBLICATION_ALLOWED = 'true';
  env.PUBLICATION_EARLIEST_WEEK = old.weeks[1];               // the first week stands for Jul 27 – Aug 2: mixed costs, held
  await mk(old.week.weekStart).compute();
  assert.equal((await mk().compute()).status, 'ok');
  const snaps = async () => (await env.DB.prepare('SELECT week_start, snapshot_id, revision, status, catalog_rev, catalog_info, comparison_snapshot_id FROM snapshot ORDER BY week_start, revision').all()).results;
  const pub = rows => Object.fromEntries(rows.filter(r => r.status === 'published').map(r => [r.week_start, r]));
  const before = await snaps();
  assert.deepEqual(Object.keys(pub(before)), weeks.slice(1), 'every week but the mixed one published');
  // The corrected catalog: catalog 1 with only the MCG table added (a pack cost for a SKU the weeks sell).
  const fixed = structuredClone(d.catalog); fixed.tables.mcg_pack = { 'MG-ALOE': 3.75, 'RAKN1499-20': null };
  const revFix = await push(fixed);
  // The correction names the older weeks (Aug 3 – Sep 21 in production) with their original catalog. The mixed
  // week and the recent weeks are not named.
  const named = old.weeks.slice(1);
  const c = await api(env, 'POST', '/v1/admin/cost-corrections', { reason: 'test: corrected MCG pack costs from Aug 1',
    weeks: named.map(w => ({ weekStart: w, fromCatalogRev: rev1, toCatalogRev: revFix })) });
  assert.equal(c.status, 200, c.text);
  const correctionId = c.json.correctionId;
  assert.deepEqual((await api(env, 'GET', '/v1/collect/corrections/pending', undefined, 'ingest')).json.weeks.map(x => x.weekStart), named);
  // Runs with the recent window: the named weeks (all outside it) are recomputed from the Worker's list.
  let r = await mk().compute(), runs = 1;
  assert.deepEqual(r.correctedWeeks, named);
  while (r.status !== 'ok' && runs < 3) { r = await mk().compute(); runs++; }
  assert.equal(r.status, 'ok', JSON.stringify(r.publication));
  const after = await snaps();
  const pa = pub(after);
  for (const w of named) {
    assert.equal(pa[w].catalog_rev, revFix, `${w} published on its corrected catalog`);
    assert.equal(JSON.parse(pa[w].catalog_info).correctionId, correctionId, `${w} records the correction it applies`);
    assert.ok(pa[w].revision > pub(before)[w].revision);
  }
  // The corrected figures differ (MG-ALOE now costs 3.75 from the MCG table); the newer weeks' do not.
  const cogs = async id => (await env.DB.prepare('SELECT known_product_cogs AS c FROM snapshot_totals WHERE snapshot_id = ?1').bind(id).first()).c;
  assert.ok((await Promise.all(named.map(async w => (await cogs(pa[w].snapshot_id)) !== (await cogs(pub(before)[w].snapshot_id))))).some(Boolean), 'a corrected cost changed the figures');
  for (const [i, w] of weeks.entries()) if (i > 1) assert.equal(pa[w].comparison_snapshot_id || null, pa[weeks[i - 1]].snapshot_id, `${w} compares with the published prior week`);
  // Later weeks keep their newer catalog: never switched to the corrected historical one.
  for (const w of d.weeks) assert.equal(pa[w].catalog_rev, revNew, `${w} keeps the newer catalog`);
  // Nothing overwritten: every earlier snapshot keeps its catalog; the mixed week is untouched and held.
  for (const b of before) assert.equal(after.find(x => x.snapshot_id === b.snapshot_id)?.catalog_rev, b.catalog_rev, `${b.snapshot_id} kept`);
  assert.deepEqual(after.filter(x => x.week_start === weeks[0]), before.filter(x => x.week_start === weeks[0]));
  assert.equal(pa[weeks[0]], undefined);
  assert.deepEqual((await api(env, 'GET', '/v1/collect/corrections/pending', undefined, 'ingest')).json.weeks, []);
  // A further run: nothing to correct or republish; a corrected week stays corrected.
  const n = after.length;
  const quiet = await mk().compute();
  assert.equal(quiet.status, 'ok');
  assert.equal((await snaps()).length, n);
});

test('collector: unmeasurable usage starts no background work; the daily check finds unfinished work cheaply and nothing once it is done', { timeout: 300_000 }, async () => {
  const d = dataset({ n: 150, scr: { zeroEvery: 1e9 } });
  const { env, fetchImpl: base } = await setup(d);
  for (const [k, v] of [['shipping_cost_auto_accept_enabled', true], ['shipping_cost_auto_accept_rules', 'flag_and_accept']]) await ok(api(env, 'POST', '/v1/admin/settings', { [k]: v, reason: `test: ${k}` }), k);
  let budgetDown = true;
  const fetchImpl = (url, init) => (budgetDown && /\/v1\/collect\/budget$/.test(url) ? Promise.reject(new TypeError('fetch failed')) : base(url, init));
  const mk = () => freeTierPipeline({ workerUrl: ORIGIN, ingestSecret: env.INGEST_SECRET, closedWeek: d.week.weekStart,
    verifyUrl: 'https://site.test/.netlify/functions/gp-verify-background', triggerSecret: TRIGGER, fetchImpl, sleep: async () => {} });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ft-')), counts = { shipstation: 0, shopify: 0 };
  // The budget cannot be read: nothing exported, nothing computed, partial (bounded retries), never "within budget".
  const a = await run(d, mk(), dir, { counts });
  assert.deepEqual([a.status, a.exitCode, a.code, counts], ['partial', EXIT.PARTIAL, 'budget_unavailable', { shipstation: 0, shopify: 0 }]);
  const c0 = await mk().compute();
  assert.deepEqual([c0.status, c0.code, c0.weeks.length], ['partial', 'budget_unavailable', 0]);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM snapshot').first()).n, 0);
  // Measurable again: the run completes.
  budgetDown = false;
  assert.equal((await run(d, mk(), dir, { counts })).exitCode, EXIT.OK);
  // Daily recovery check: nothing unfinished → the start can exit at once.
  assert.deepEqual((await mk().work()).unfinished, []);
  // A verification lost later (e.g. a verifier failure): the check finds it, and resuming it needs no export.
  await env.DB.prepare('DELETE FROM verify_report WHERE snapshot_id = (SELECT snapshot_id FROM snapshot ORDER BY week_start LIMIT 1)').run();
  assert.deepEqual((await mk().work()).unfinished, ['verification_backlog']);
  const r = await run(d, mk(), dir, { counts });
  assert.equal(r.exitCode, EXIT.OK);
  assert.deepEqual(counts, { shipstation: 1, shopify: 1 }, 'no export repeated');
  assert.deepEqual((await mk().work()).unfinished, []);
});
