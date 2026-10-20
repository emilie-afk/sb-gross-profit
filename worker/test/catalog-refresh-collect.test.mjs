/**
 * Free tier: the collector's weekly catalog refresh through the Netlify build hook
 *   POST /v1/collect/catalog-refresh { weeks }   (one batch, one build, atomic claim, backoff)
 *   GET  /v1/collect/catalog-refresh/:id         (status only)
 * and the catalog a week computes on afterwards.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as FT from '../../automation/collector/src/freeTier.mjs';
import { dataset, freeTierRun, api, ok, runVerifier } from './freeTierHarness.mjs';
import { chooseCatalogFrom } from '../src/compute.js';
import { requestCatalogRefresh, HOOK_FAILURE_LIMIT, backoffMs } from '../src/catalogRefreshCollect.js';

const HOOK = 'https://api.netlify.com/build_hooks/abcdef0123456789abcdef01';
const gateOf = async (env, w) => JSON.parse((await env.DB.prepare('SELECT r.gate FROM snapshot s JOIN reporting_run r ON r.run_id = s.run_id WHERE s.week_start = ?1 ORDER BY s.revision DESC LIMIT 1').bind(w).first()).gate);
const newest = (env, w) => env.DB.prepare('SELECT snapshot_id, revision, status, catalog_rev, catalog_info FROM snapshot WHERE week_start = ?1 ORDER BY revision DESC LIMIT 1').bind(w).first();
const rows = env => env.DB.prepare('SELECT refresh_id, week_start, status, requested_at, resolved_at, detail FROM catalog_refresh ORDER BY requested_at').all().then(r => r.results);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Route calls with the Worker's outbound fetch (the build hook) captured. */
async function withHook(fn, respond = async () => new Response('', { status: 200 })) {
  const calls = [], real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null }); return respond(url, init); };
  try { return { result: await fn(), calls }; } finally { globalThis.fetch = real; }
}
const ask = (env, weeks) => api(env, 'POST', '/v1/collect/catalog-refresh', { weeks }, 'ingest');
const status = (env, id) => api(env, 'GET', `/v1/collect/catalog-refresh/${id}`, undefined, 'ingest');
const buildPush = (env, d, refreshId) => ok(api(env, 'POST', '/v1/ingest/catalog', { ...d.catalog, meta: { ...(d.catalog.meta || {}), refreshId } }, 'ingest'), 'build push');
/** Pretend a refresh row was written `minutes` ago. */
const age = (env, id, minutes) => env.DB.prepare('UPDATE catalog_refresh SET requested_at = ?2, resolved_at = CASE WHEN resolved_at IS NULL THEN NULL ELSE ?2 END WHERE refresh_id = ?1')
  .bind(id, new Date(Date.now() - minutes * 60_000).toISOString()).run();

async function stale(n = 60) {
  const d = dataset({ n });
  const ft = await freeTierRun(d, { verify: false });
  ft.env.NETLIFY_BUILD_HOOK_URL = HOOK;
  return { d, ...ft };
}

test('two stale weeks: one batch, one build, both fulfilled by the build push; polling never builds', async () => {
  const { d, env } = await stale();
  const [, w1, w2] = d.weeks;
  for (const w of [w1, w2]) assert.ok((await gateOf(env, w)).failures.some(f => f.code === 'catalog_stale'), `${w} stale before any refresh`);
  const first = await withHook(() => ask(env, [w2, w1]));
  const r = first.result.json;
  assert.equal(r.status, 'requested');
  assert.deepEqual([r.weeks[w1].status, r.weeks[w2].status], ['requested', 'requested']);
  assert.equal(first.calls.length, 1, 'one build for both weeks');
  assert.ok(first.calls[0].url.startsWith(`${HOOK}?trigger_title=`));
  assert.deepEqual(first.calls[0].body, { refreshId: r.refreshId, weekStart: w2 });
  assert.ok(!JSON.stringify(r).includes('build_hooks'), 'the hook URL is never returned');
  // Status polling: read only.
  const before = (await rows(env)).length;
  const polled = await withHook(() => status(env, r.refreshId));
  assert.deepEqual([polled.result.json.status, polled.result.json.weeks, polled.calls.length], ['pending', [w1, w2], 0]);
  assert.equal((await rows(env)).length, before, 'polling writes nothing');
  // Asked again while the build runs: same refresh, no second build.
  const again = await withHook(() => ask(env, [w1, w2]));
  assert.deepEqual([again.result.json.status, again.result.json.refreshId, again.calls.length], ['pending', r.refreshId, 0]);
  // The build pushes: both weeks fulfilled.
  assert.equal((await buildPush(env, d, r.refreshId)).refresh.status, 'fulfilled');
  assert.equal((await status(env, r.refreshId)).json.status, 'fulfilled');
  const done = (await ask(env, [w1, w2])).json;
  assert.deepEqual([done.status, done.weeks[w1].status, done.weeks[w2].status], ['not_needed', 'fulfilled', 'fulfilled']);
});

test('concurrent requests: the atomic claim starts exactly one build', async () => {
  const { d, env } = await stale();
  const [, w1, w2] = d.weeks;
  // A slow hook so both requests overlap between their checks and the claim.
  const { result, calls } = await withHook(() => Promise.all([ask(env, [w1, w2]), ask(env, [w1, w2]), ask(env, [w1])]),
    async () => { await sleep(30); return new Response('', { status: 200 }); });
  const statuses = result.map(r => r.json.status).sort();
  assert.equal(calls.length, 1, `one build hook call, got ${calls.length}`);
  assert.deepEqual(statuses.filter(s => s === 'requested'), ['requested']);
  assert.ok(statuses.every(s => s === 'requested' || s === 'pending'), statuses.join());
  assert.equal(new Set(result.map(r => r.json.refreshId)).size, 1, 'everyone sees the same refresh');
  assert.equal((await rows(env)).filter(x => x.status === 'pending').length, 1, 'one pending refresh');
});

test('failed hooks back off (persisted) and stop at the limit; a success clears the count', async () => {
  const { d, env } = await stale();
  const [, w1] = d.weeks;
  const fail = async () => new Response('nope', { status: 500 });
  const f1 = await withHook(() => ask(env, [w1]), fail);
  assert.deepEqual([f1.result.json.status, f1.result.json.httpStatus, f1.calls.length], ['hook_failed', 500, 1]);
  assert.equal((await rows(env)).at(-1).status, 'rejected');
  // Immediately again (the collector's next run, or a retry): backoff, no build.
  const b = await withHook(() => ask(env, [w1]), fail);
  assert.deepEqual([b.result.json.status, b.calls.length], ['backoff', 0]);
  assert.ok(Date.parse(b.result.json.retryAfter) > Date.now());
  // Past the backoff: one more attempt each time, until the limit.
  for (let n = 2; n <= HOOK_FAILURE_LIMIT; n++) {
    for (const x of await rows(env)) await age(env, x.refresh_id, backoffMs(n) / 60_000 + 1 > 60 * 23 ? 60 * 23 : backoffMs(n) / 60_000 + 1);
    const fn = await withHook(() => ask(env, [w1]), fail);
    assert.deepEqual([fn.result.json.status, fn.calls.length], ['hook_failed', 1], `attempt ${n}`);
  }
  for (const x of await rows(env)) await age(env, x.refresh_id, 60 * 7);
  const lim = await withHook(() => ask(env, [w1]), fail);
  assert.deepEqual([lim.result.json.status, lim.result.json.failures, lim.calls.length], ['retry_limit', HOOK_FAILURE_LIMIT, 0]);
  // A day later the failures fall out of the window; a successful call clears the count.
  for (const x of await rows(env)) await age(env, x.refresh_id, 60 * 25);
  const okCall = await withHook(() => ask(env, [w1]));
  assert.deepEqual([okCall.result.json.status, okCall.calls.length], ['requested', 1]);
});

test('the hook call has its own timeout', async () => {
  const { d, env } = await stale();
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const req = new Request('https://w.local/v1/collect/catalog-refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ weeks: [d.weeks[1]] }) });
  const t0 = Date.now();
  const res = await (await requestCatalogRefresh(req, env, { fetchImpl: hang, hookTimeoutMs: 50 })).json();
  assert.deepEqual([res.status, res.reason], ['hook_failed', 'build_hook_timeout']);
  assert.ok(Date.now() - t0 < 5000);
  assert.equal((await rows(env)).at(-1).status, 'rejected', 'the timed-out refresh is closed, not left pending');
});

test('a build that never answers expires; a late build resolves nothing; the next request starts a new batch', async () => {
  const { d, env } = await stale();
  const [, w1, w2] = d.weeks;
  const a = (await withHook(() => ask(env, [w1, w2]))).result.json;
  await age(env, a.refreshId, 50);                                     // the build was cancelled or is stuck
  assert.equal((await status(env, a.refreshId)).json.status, 'expired', 'status reports it expired');
  const b = await withHook(() => ask(env, [w1, w2]));
  assert.deepEqual([b.result.json.status, b.calls.length], ['requested', 1]);
  const all = await rows(env);
  assert.equal(all.find(x => x.refresh_id === a.refreshId).status, 'expired', 'closed, not left unresolved');
  // The delayed first build finally pushes: resolves nothing.
  assert.equal((await buildPush(env, d, a.refreshId)).refresh.status, 'expired');
  // The new batch's build pushes: fulfilled.
  assert.equal((await buildPush(env, d, b.result.json.refreshId)).refresh.status, 'fulfilled');
});

test('weeks that miss an in-flight batch are queued for the next one', async () => {
  const { d, env } = await stale();
  const [, w1, w2] = d.weeks;
  const a = (await withHook(() => ask(env, [w1]))).result.json;
  const q = await withHook(() => ask(env, [w1, w2]));
  assert.deepEqual([q.result.json.weeks[w1].status, q.result.json.weeks[w2].status, q.calls.length], ['pending', 'queued', 0]);
  await buildPush(env, d, a.refreshId);
  const n = await withHook(() => ask(env, [w1, w2]));
  assert.deepEqual([n.result.json.weeks[w1].status, n.result.json.weeks[w2].status, n.calls.length], ['fulfilled', 'requested', 1]);
});

test('route: published, open, pre-publication and already-fresh weeks need nothing; bad input and missing hook refused', async () => {
  const { d, env } = await stale();
  const [w0, w1, w2] = d.weeks;
  env.PUBLICATION_EARLIEST_WEEK = w1;
  await env.DB.prepare("UPDATE snapshot SET status = 'published' WHERE week_start = ?1").bind(w2).run();
  const s = await newest(env, w1);
  await env.DB.prepare('UPDATE snapshot SET catalog_info = ?2 WHERE snapshot_id = ?1').bind(s.snapshot_id, JSON.stringify({ ...JSON.parse(s.catalog_info), freshness: { status: 'current' } })).run();
  const future = '2099-01-05';                                                       // a Monday, not yet over
  const r = await withHook(() => ask(env, [w0, w1, w2, future]));
  assert.equal(r.result.json.status, 'not_needed');
  assert.deepEqual(Object.fromEntries(Object.entries(r.result.json.weeks).map(([w, v]) => [w, v.reason])),
    { [w0]: 'before_publication_start', [w1]: 'catalog_current', [w2]: 'published', [future]: 'week_open' });
  assert.equal(r.calls.length, 0);
  assert.equal((await ask(env, ['2020-03-10'])).status, 400, 'not a Monday');
  assert.equal((await ask(env, [])).status, 400);
  delete env.NETLIFY_BUILD_HOOK_URL;
  const none = await ask(env, [d.weeks[3]]);
  assert.deepEqual([none.status, none.json.error], [409, 'build_hook_unconfigured']);
  assert.equal((await rows(env)).length, 0, 'nothing registered without a hook');
  assert.equal((await status(env, 'crf_00000000000000000000')).status, 404);
});

test('end to end: stale weeks recompute on their batch catalog, pass the catalog check without approval, then stay unchanged', async () => {
  const d = dataset({ n: 80 });
  const ft = await freeTierRun(d);
  const { env, c } = ft, [, w1, w2, w3] = d.weeks;
  env.NETLIFY_BUILD_HOOK_URL = HOOK;
  const w3Before = await newest(env, w3);
  assert.equal((await FT.computeAndUploadWeek(c, w1, FT.newCache())).status, 'unchanged', 'no churn before a refresh');
  const { result } = await withHook(() => ask(env, [w1, w2]));
  await buildPush(env, d, result.json.refreshId);
  for (const w of [w1, w2]) {
    const before = await newest(env, w);
    const r = await FT.computeAndUploadWeek(c, w, FT.newCache());
    assert.equal(r.status, 'computed', `${w}: the fulfilled batch is a new input`);
    assert.equal((await runVerifier(env, r.snapshotId)).body.status, 'verified');
    const after = await newest(env, w);
    const info = JSON.parse(after.catalog_info);
    assert.deepEqual([info.basis, info.refreshId, info.freshness?.status], ['week_refresh', result.json.refreshId, 'current']);
    assert.ok(!(await gateOf(env, w)).failures.some(f => f.code === 'catalog_stale'), `${w}: catalog check passes`);
    assert.ok(after.revision > before.revision);
    assert.equal((await FT.computeAndUploadWeek(c, w, FT.newCache())).status, 'unchanged', `${w}: no loop`);
  }
  // A week outside the batch keeps its inputs.
  assert.equal((await FT.computeAndUploadWeek(c, w3, FT.newCache())).status, 'unchanged');
  assert.equal((await newest(env, w3)).revision, w3Before.revision);
  // Publishing keeps the inputs.
  await env.DB.prepare("UPDATE snapshot SET status = 'published' WHERE snapshot_id = ?1").bind((await newest(env, w1)).snapshot_id).run();
  assert.equal((await FT.computeAndUploadWeek(c, w1, FT.newCache())).status, 'unchanged', 'publication does not change the inputs');
});

test('collector: one request, read-only polling, bounded wait, recovery after an interrupted wait', async () => {
  const { d, env, c } = await stale();
  const [, w1, w2] = d.weeks;
  let t = 0, polls = 0;
  const clock = { sleep: async ms => { t += ms; polls++; }, now: () => t };
  const first = await withHook(() => FT.ensureCatalogRefreshes(c, [w1, w2], { waitMs: 60_000, pollMs: 30_000, ...clock }));
  assert.equal(first.calls.length, 1, 'one build');
  assert.deepEqual([first.result.status, first.result.weeks[w1], first.result.weeks[w2]], ['pending', 'pending', 'pending']);
  assert.ok(polls <= 3 && t <= 90_000, 'the wait is bounded');
  // The run was interrupted while waiting; the build lands later. The next run finds both weeks fulfilled
  // without starting a build, and computes them on the refreshed catalog.
  await buildPush(env, d, first.result.refreshId);
  const next = await withHook(() => FT.ensureCatalogRefreshes(c, [w1, w2], { waitMs: 60_000, ...clock }));
  assert.deepEqual([next.result.status, next.result.weeks[w1], next.result.weeks[w2], next.calls.length], ['not_needed', 'fulfilled', 'fulfilled', 0]);
  for (const w of [w1, w2]) assert.equal((await FT.computeAndUploadWeek(c, w, FT.newCache())).status, 'computed');
  // An older Worker without the route.
  const old = { async call() { throw new FT.WorkerCallError(404, 'not_found'); } };
  assert.deepEqual(await FT.ensureCatalogRefreshes(old, [w1], { waitMs: 0 }), { status: 'unsupported', weeks: { [w1]: 'unsupported' } });
});

test('chooseCatalogFrom: a fulfilled refresh replaces only a stale unpublished anchor (or supplies a new week)', () => {
  const fulfilled = { refresh_id: 'crf_00000000000000000001', catalog_rev: 'cat_bbbbbbbbbbbbbbbb' };
  const stale = { rev: 'cat_aaaaaaaaaaaaaaaa', basis: 'previous_snapshot', fromSnapshotId: 'snp_x', inheritedFreshness: 'stale' };
  const want = { rev: fulfilled.catalog_rev, basis: 'week_refresh', refreshId: fulfilled.refresh_id };
  assert.deepEqual(chooseCatalogFrom({ anchor: stale, fulfilled }), want);
  assert.deepEqual(chooseCatalogFrom({ anchor: null, latest: { catalog_rev: 'cat_cccccccccccccccc' }, fulfilled }), want, 'a new week named by a batch');
  for (const fresh of ['current', 'restated', 'reused_accepted', 'intentionally_reused']) {
    assert.equal(chooseCatalogFrom({ anchor: { ...stale, inheritedFreshness: fresh }, fulfilled }).rev, stale.rev, `${fresh} anchor is kept`);
  }
  const published = { rev: 'cat_aaaaaaaaaaaaaaaa', basis: 'published_snapshot', fromSnapshotId: 'snp_p' };
  assert.equal(chooseCatalogFrom({ anchor: published, fulfilled }).basis, 'published_snapshot', 'a published week keeps its pinned catalog');
  assert.equal(chooseCatalogFrom({ anchor: stale }).rev, stale.rev, 'no refresh: unchanged');
});
