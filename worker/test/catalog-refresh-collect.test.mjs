/**
 * Free tier: the collector's weekly catalog refresh through the Netlify build hook
 * (POST /v1/collect/weeks/:w/catalog-refresh) and the catalog a week computes on afterwards.
 *   - a week with no refresh of its own computes stale (gate catalog_stale), as before;
 *   - the route registers ONE refresh and calls the build hook with { refreshId, weekStart };
 *   - the build's push with that id fulfils it; the stale, unpublished week then recomputes on the
 *     refreshed catalog (basis week_refresh) and passes the catalog check, with no owner approval;
 *   - recomputing again changes nothing; a published week keeps its pinned catalog; weeks with no
 *     refresh keep their inputs (no mass recompute after deploy).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as FT from '../../automation/collector/src/freeTier.mjs';
import { dataset, freeTierRun, api, ok, runVerifier } from './freeTierHarness.mjs';
import { chooseCatalogFrom } from '../src/compute.js';

const HOOK = 'https://api.netlify.com/build_hooks/abcdef0123456789abcdef01';
const gateOf = async (env, w) => JSON.parse((await env.DB.prepare('SELECT r.gate FROM snapshot s JOIN reporting_run r ON r.run_id = s.run_id WHERE s.week_start = ?1 ORDER BY s.revision DESC LIMIT 1').bind(w).first()).gate);
const newest = (env, w) => env.DB.prepare('SELECT snapshot_id, revision, status, catalog_rev, catalog_info FROM snapshot WHERE week_start = ?1 ORDER BY revision DESC LIMIT 1').bind(w).first();

/** Route calls with the Worker's outbound fetch (the build hook) captured. */
async function withHook(fn, respond = () => new Response('', { status: 200 })) {
  const calls = [], real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return respond(url, init); };
  try { return { result: await fn(), calls }; } finally { globalThis.fetch = real; }
}
const refreshFor = (env, w) => api(env, 'POST', `/v1/collect/weeks/${w}/catalog-refresh`, {}, 'ingest');

test('route: unconfigured hook, request once, pending reuse, fulfilment by the build push', async () => {
  const d = dataset({ n: 60 });
  const { env } = await freeTierRun(d, { verify: false });
  const w1 = d.weeks[1];
  assert.ok((await gateOf(env, w1)).failures.some(f => f.code === 'catalog_stale'), 'stale before any refresh');

  // No hook configured: refused, nothing registered.
  const none = await refreshFor(env, w1);
  assert.deepEqual([none.status, none.json.error], [409, 'build_hook_unconfigured']);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM catalog_refresh').first()).n, 0);

  env.NETLIFY_BUILD_HOOK_URL = HOOK;
  const first = await withHook(() => refreshFor(env, w1));
  assert.equal(first.result.json.status, 'requested');
  const refreshId = first.result.json.refreshId;
  assert.match(refreshId, /^crf_[0-9a-f]{20}$/);
  assert.equal(first.calls.length, 1, 'one build hook call');
  assert.ok(first.calls[0].url.startsWith(`${HOOK}?trigger_title=`));
  assert.deepEqual(JSON.parse(first.calls[0].init.body), { refreshId, weekStart: w1 }, 'the build receives the refresh id (INCOMING_HOOK_BODY)');
  assert.ok(!JSON.stringify(first.result.json).includes('build_hooks'), 'the hook URL is never returned');

  // Asked again while the build runs: the same refresh, no second build.
  const again = await withHook(() => refreshFor(env, w1));
  assert.deepEqual([again.result.json.status, again.result.json.refreshId, again.calls.length], ['pending', refreshId, 0]);

  // The build pushes the catalog with that id: fulfilled.
  const push = await ok(api(env, 'POST', '/v1/ingest/catalog', { ...d.catalog, meta: { ...(d.catalog.meta || {}), refreshId } }, 'ingest'), 'build push');
  assert.equal(push.refresh.status, 'fulfilled');
  const done = await withHook(() => refreshFor(env, w1));
  assert.deepEqual([done.result.json.status, done.result.json.refreshId, done.calls.length], ['fulfilled', refreshId, 0]);
});

test('route: published, open, pre-publication and already-fresh weeks need nothing; a failed hook closes the refresh', async () => {
  const d = dataset({ n: 60 });
  const { env } = await freeTierRun(d, { verify: false });
  env.NETLIFY_BUILD_HOOK_URL = HOOK;
  const [w0, w1, w2] = d.weeks;
  env.PUBLICATION_EARLIEST_WEEK = w1;
  assert.deepEqual((await refreshFor(env, w0)).json, { weekStart: w0, status: 'not_needed', reason: 'before_publication_start' });
  const future = '2099-01-05';   // a Monday
  assert.deepEqual((await refreshFor(env, future)).json, { weekStart: future, status: 'not_needed', reason: 'week_open' });
  assert.equal((await refreshFor(env, '2020-03-10')).status, 400, 'not a Monday');
  await env.DB.prepare("UPDATE snapshot SET status = 'published' WHERE week_start = ?1").bind(w2).run();
  assert.deepEqual((await refreshFor(env, w2)).json, { weekStart: w2, status: 'not_needed', reason: 'published' });
  // A week whose newest revision already used a fresh catalog.
  const s = await newest(env, w1);
  const info = { ...JSON.parse(s.catalog_info), freshness: { status: 'current' } };
  await env.DB.prepare('UPDATE snapshot SET catalog_info = ?2 WHERE snapshot_id = ?1').bind(s.snapshot_id, JSON.stringify(info)).run();
  assert.deepEqual((await refreshFor(env, w1)).json, { weekStart: w1, status: 'not_needed', reason: 'catalog_current' });
  // Hook failure: reported, the refresh is closed (rejected), the next run asks again.
  const w3 = d.weeks[3];
  const failed = await withHook(() => refreshFor(env, w3), () => new Response('nope', { status: 500 }));
  assert.deepEqual([failed.result.json.status, failed.result.json.httpStatus], ['hook_failed', 500]);
  assert.equal((await env.DB.prepare('SELECT status FROM catalog_refresh WHERE refresh_id = ?1').bind(failed.result.json.refreshId).first()).status, 'rejected');
  const retried = await withHook(() => refreshFor(env, w3));
  assert.equal(retried.result.json.status, 'requested', 'a later run requests a new refresh');
});

test('end to end: a stale unpublished week recomputes on its refreshed catalog and passes the catalog check without approval', async () => {
  const d = dataset({ n: 80 });
  const ft = await freeTierRun(d);
  const { env, c } = ft, [, w1, w2] = d.weeks;
  env.NETLIFY_BUILD_HOOK_URL = HOOK;
  const before = await newest(env, w1);
  const otherBefore = await newest(env, w2);
  // Nothing changed yet: recomputing gives the same inputs (no churn).
  assert.equal((await FT.computeAndUploadWeek(c, w1, FT.newCache())).status, 'unchanged');

  const { result } = await withHook(() => refreshFor(env, w1));
  await ok(api(env, 'POST', '/v1/ingest/catalog', { ...d.catalog, meta: { ...(d.catalog.meta || {}), refreshId: result.json.refreshId } }, 'ingest'), 'build push');

  const r = await FT.computeAndUploadWeek(c, w1, FT.newCache());
  assert.equal(r.status, 'computed', 'the fulfilled refresh is a new input for the stale week');
  assert.equal((await runVerifier(env, r.snapshotId)).body.status, 'verified', 'the verifier recomputes the same figures');
  const after = await newest(env, w1);
  const info = JSON.parse(after.catalog_info);
  assert.deepEqual([info.basis, info.refreshId, info.freshness?.status], ['week_refresh', result.json.refreshId, 'current']);
  assert.ok(!(await gateOf(env, w1)).failures.some(f => f.code === 'catalog_stale'), 'catalog check passes');
  assert.ok(after.revision > before.revision);
  // Recomputing again: unchanged (no loop).
  assert.equal((await FT.computeAndUploadWeek(c, w1, FT.newCache())).status, 'unchanged');
  // Another week without a refresh of its own: inputs unchanged, still the same revision.
  assert.equal((await FT.computeAndUploadWeek(c, w2, FT.newCache())).status, 'unchanged');
  assert.equal((await newest(env, w2)).revision, otherBefore.revision);
  // Publishing the refreshed week keeps its inputs: the next compute is still unchanged.
  await env.DB.prepare("UPDATE snapshot SET status = 'published' WHERE snapshot_id = ?1").bind(after.snapshot_id).run();
  assert.equal((await FT.computeAndUploadWeek(c, w1, FT.newCache())).status, 'unchanged', 'publication does not change the inputs');
});

test('chooseCatalogFrom: a fulfilled refresh replaces only a stale unpublished anchor', () => {
  const fulfilled = { refresh_id: 'crf_00000000000000000001', catalog_rev: 'cat_bbbbbbbbbbbbbbbb' };
  const stale = { rev: 'cat_aaaaaaaaaaaaaaaa', basis: 'previous_snapshot', fromSnapshotId: 'snp_x', inheritedFreshness: 'stale' };
  assert.deepEqual(chooseCatalogFrom({ anchor: stale, fulfilled }), { rev: fulfilled.catalog_rev, basis: 'week_refresh', refreshId: fulfilled.refresh_id });
  for (const fresh of ['current', 'restated', 'reused_accepted', 'intentionally_reused']) {
    assert.equal(chooseCatalogFrom({ anchor: { ...stale, inheritedFreshness: fresh }, fulfilled }).rev, stale.rev, `${fresh} anchor is kept`);
  }
  const published = { rev: 'cat_aaaaaaaaaaaaaaaa', basis: 'published_snapshot', fromSnapshotId: 'snp_p' };
  assert.equal(chooseCatalogFrom({ anchor: published, fulfilled }).basis, 'published_snapshot', 'a published week keeps its pinned catalog');
  assert.equal(chooseCatalogFrom({ anchor: stale }).rev, stale.rev, 'no refresh: unchanged');
});

test('collector: refreshes requested before computing, bounded wait, older Worker tolerated', async () => {
  const seq = { '2026-10-05': ['requested', 'pending', 'fulfilled'], '2026-10-12': ['not_needed'], '2026-10-19': ['requested', 'pending', 'pending', 'pending'] };
  const asked = [];
  const c = { async call(method, path) {
    const w = path.match(/weeks\/([\d-]+)\/catalog-refresh/)[1]; asked.push(w);
    const q = seq[w]; return { status: q.length > 1 ? q.shift() : q[0] };
  } };
  let t = 0;
  const out = await FT.ensureCatalogRefreshes(c, Object.keys(seq), { waitMs: 90_000, pollMs: 30_000, sleep: async ms => { t += ms; }, now: () => t });
  assert.deepEqual(out, { '2026-10-05': 'fulfilled', '2026-10-12': 'not_needed', '2026-10-19': 'pending' });
  assert.ok(t <= 90_000 + 30_000, 'the wait is bounded');
  assert.equal(asked.filter(w => w === '2026-10-12').length, 1, 'a week that needs nothing is asked once');
  const old = { async call() { throw new FT.WorkerCallError(404, 'not_found'); } };
  assert.deepEqual(await FT.ensureCatalogRefreshes(old, ['2026-10-05'], { waitMs: 0 }), { '2026-10-05': 'unsupported' });
});
