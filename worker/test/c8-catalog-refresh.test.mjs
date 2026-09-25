/**
 * C8 — the weekly catalog refresh is created and executed by the Worker's own
 * tick (no admin action, no admin HTTP call): one logical refresh per week,
 * concurrency-safe, transient failures retried at most hourly to the cutoff,
 * rejection activates nothing, audited reuse stays the fallback, and no sheet
 * address or content reaches D1, events or API output. Stubbed fetch,
 * synthetic sheets.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { loaded, admin, call, sessionCookie, catalog, ingest, viaNormalized, WEEK, asOf } from './helpers.mjs';
import { syntheticSheets } from '../../tests/fixtures-catalog.mjs';
import { OVERLAY_SOURCES } from '../../shared/catalogOverlay.js';
import { ensureWeeklyCatalogRefresh, autoRefreshId, isTransientCode } from '../src/catalogFetch.js';

const MARK = `PUBSHEET${crypto.randomUUID().replace(/-/g, '')}`;
const GID = 7_654_321;
const urlFor = k => `https://docs.google.com/spreadsheets/d/${MARK}/export?format=csv&gid=${GID + OVERLAY_SOURCES.indexOf(k)}`;
const FIRST = '2026-09-21T08:30:00Z', CUTOFF = '2026-09-22T08:30:00.000Z';

/** A controllable sheet host: `mode` = 'ok' | 'transient' | 'html' | 'shrunk'. */
function host() {
  const sheets = syntheticSheets({ scale: true });
  const h = { mode: 'ok', calls: 0, delayMs: 0 };
  h.fetch = async url => {
    const k = OVERLAY_SOURCES.find(s => urlFor(s) === String(url));
    if (!k) return new Response('nope', { status: 404 });
    h.calls++;
    if (h.delayMs) await new Promise(r => setTimeout(r, h.delayMs));
    if (h.mode === 'transient' && k === OVERLAY_SOURCES[0]) return new Response('busy', { status: 503 });
    if (h.mode === 'html') return new Response('<!doctype html><title>Sign in</title>', { headers: { 'content-type': 'text/html' } });
    const text = h.mode === 'shrunk' && k === OVERLAY_SOURCES[0] ? sheets[k].split('\n').slice(0, 2).join('\n') : sheets[k];
    return new Response(text, { headers: { 'content-type': 'text/csv' } });
  };
  return h;
}
async function withFetch(stub, fn) { const o = globalThis.fetch; globalThis.fetch = stub; try { return await fn(); } finally { globalThis.fetch = o; } }
const baseTables = () => { const t = catalog().tables; const { vendor_costs: _v, vendor_index: _i, ...rest } = t; return { ...rest, mcg_total: { PLACEHOLDER: 1, S2KY2965: 4.5 }, product_costs: { 'HPX-1': 9 } }; };

/** A week with every source in except the catalog refresh (none registered for it). */
async function week() {
  const sources = Object.fromEntries(OVERLAY_SOURCES.map(k => [k, urlFor(k)]));
  const { env } = await loaded(20, { CATALOG_SOURCES_JSON: JSON.stringify(sources), TEST_HOOKS_ENABLED: 'true' }, { refresh: false });
  assert.equal((await ingest(env, '/v1/ingest/shopify', viaNormalized({ mode: 'updated_since', nodes: [], weekStart: WEEK }))).status, 200);
  const base = await admin(env, 'POST', '/v1/admin/catalog/base', { tables: baseTables(), reason: 'pinned existing cost files (test)' });
  assert.equal((await admin(env, 'POST', '/v1/admin/settings', { catalog_overlay_base_rev: base.json.baseCatalogRev, reason: 'C6d overlay on the pinned base (test)' })).status, 200);
  return env;
}
const tick = async (env, h, iso) => { await asOf(env, iso); return withFetch(h.fetch, () => worker.scheduled({ scheduledTime: Date.parse(iso) }, env, null)); };
const refreshes = async env => (await env.DB.prepare('SELECT * FROM catalog_refresh WHERE week_start = ?1 ORDER BY requested_at').bind(WEEK).all()).results;
const cycle = env => env.DB.prepare('SELECT * FROM schedule_cycle WHERE week_start = ?1').bind(WEEK).first();
const runOf = async env => env.DB.prepare('SELECT * FROM reporting_run WHERE run_id = ?1').bind((await cycle(env)).run_id).first();
const accepted = async env => (await env.DB.prepare("SELECT COUNT(*) n FROM cost_catalog WHERE status = 'accepted'").first()).n;
async function dbText(env) {
  const tables = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).results.map(r => r.name);
  let s = ''; for (const t of tables) s += JSON.stringify((await env.DB.prepare(`SELECT * FROM "${t}"`).all()).results); return s;
}
const leaks = text => [MARK, 'docs.google', 'gid=', String(GID)].filter(x => text.includes(x));

test('C8 catalog: transient codes are the retryable ones only', () => {
  for (const c of ['network_error', 'timeout', 'http_429', 'http_500', 'http_503']) assert.equal(isTransientCode(c), true, c);
  for (const c of ['http_403', 'http_404', 'html_response', 'empty', 'not_utf8', 'too_large', 'parse_failed']) assert.equal(isTransientCode(c), false, c);
});

test('C8 catalog: a normal week needs no admin action — the first attempt refreshes, pins and computes', async () => {
  const env = await week(), h = host();
  const t = await tick(env, h, FIRST);
  const rs = await refreshes(env);
  assert.equal(rs.length, 1, 'one logical refresh for the week');
  assert.deepEqual([rs[0].refresh_id, rs[0].status, rs[0].requested_by_class, rs[0].requested_by_label], [await autoRefreshId(WEEK), 'fulfilled', 'worker', 'cron']);
  assert.equal(h.calls, OVERLAY_SOURCES.length, 'each public tab fetched once');
  assert.deepEqual(t.catalogRefresh, { status: 'fulfilled', action: 'fetched', reason: null });
  const run = await runOf(env);
  assert.ok(['validated', 'blocked'].includes(run.state), `computed in the same attempt (${run.state})`);
  const gate = JSON.parse(run.gate);
  assert.deepEqual([gate.catalog.basis, gate.catalog.freshness.status, gate.catalog.selectedRev], ['week_refresh', 'current', rs[0].catalog_rev]);
  assert.equal(run.catalog_rev, rs[0].catalog_rev, 'the compute pinned the refreshed catalog');
  // Later ticks do not fetch again.
  for (const iso of ['2026-09-21T08:45:00Z', '2026-09-21T09:30:00Z', '2026-09-21T12:30:00Z']) await tick(env, h, iso);
  assert.equal(h.calls, OVERLAY_SOURCES.length);
  assert.equal((await refreshes(env)).length, 1);
  // Nothing sheet-identifying anywhere: D1, events, tick output, status API.
  const status = await call(env, 'GET', `/v1/automation/status?weekStart=${WEEK}`, { cookie: await sessionCookie(env) });
  const cyc = await admin(env, 'GET', `/v1/admin/cycles/${WEEK}`);
  assert.ok(cyc.json.events.some(e => e.step === 'catalog_refresh' && e.status === 'fulfilled'));
  assert.deepEqual(leaks(await dbText(env) + JSON.stringify(t) + JSON.stringify(status.json) + JSON.stringify(cyc.json)), []);
});

test('C8 catalog: concurrent executions cannot create or run a second refresh', async () => {
  const env = await week(), h = host();
  h.delayMs = 30;
  const at = new Date(FIRST);
  const res = await withFetch(h.fetch, () => Promise.all(Array.from({ length: 6 }, () => ensureWeeklyCatalogRefresh(env, { weekStart: WEEK, at, cutoffAt: CUTOFF }))));
  assert.equal(res.filter(r => r.action === 'fetched').length, 1, JSON.stringify(res.map(r => r.reason || r.status)));
  assert.equal(h.calls, OVERLAY_SOURCES.length);
  const rs = await refreshes(env);
  assert.deepEqual([rs.length, rs[0].status], [1, 'fulfilled']);
  // Parallel ticks too (lease + claim): still one refresh, one fetch round.
  const env2 = await week(), h2 = host();
  await asOf(env2, FIRST);
  await withFetch(h2.fetch, () => Promise.all(Array.from({ length: 5 }, () => worker.scheduled({ scheduledTime: Date.parse(FIRST) }, env2, null))));
  assert.deepEqual([(await refreshes(env2)).length, h2.calls], [1, OVERLAY_SOURCES.length]);
});

test('C8 catalog: a transient failure activates nothing and retries at most once per hour', async () => {
  const env = await week(), h = host();
  const before = await accepted(env);
  h.mode = 'transient';
  const t = await tick(env, h, FIRST);
  assert.equal(t.catalogRefresh.status, 'retrying');
  let [r] = await refreshes(env);
  assert.equal(r.status, 'pending');
  assert.equal(JSON.parse(r.detail).retryAfter, '2026-09-21T09:30:00.000Z');
  assert.equal(await accepted(env), before, 'nothing activated');
  assert.deepEqual(t.attempts[0].missing, ['catalog_refresh:retrying']);
  const round = h.calls;
  for (const iso of ['2026-09-21T08:45:00Z', '2026-09-21T09:00:00Z', '2026-09-21T09:15:00Z']) await tick(env, h, iso);
  assert.equal(h.calls, round, 'no fetch before the hour is up');
  h.mode = 'ok';
  await tick(env, h, '2026-09-21T09:30:00Z');
  [r] = await refreshes(env);
  assert.deepEqual([r.status, JSON.parse(r.detail).attempts, (await refreshes(env)).length], ['fulfilled', 2, 1]);
  assert.ok(['validated', 'blocked'].includes((await runOf(env)).state));
});

test('C8 catalog: transient failures through the cutoff reject the refresh; the week waits; audited reuse is the fallback', async () => {
  const env = await week(), h = host();
  const before = await accepted(env);
  h.mode = 'transient';
  const hourly = []; for (let t = Date.parse(FIRST); t <= Date.parse(CUTOFF); t += 15 * 60_000) hourly.push(new Date(t).toISOString());
  for (const iso of hourly) await tick(env, h, iso);
  const [r] = await refreshes(env);
  const d = JSON.parse(r.detail);
  assert.equal(r.status, 'rejected');
  assert.ok(d.reasons.includes('transient_retries_exhausted'));
  assert.equal(d.attempts, 25, 'one attempt per hour, 08:30 Monday through 08:30 Tuesday');
  assert.equal(h.calls, 25 * OVERLAY_SOURCES.length);
  assert.equal(await accepted(env), before, 'never an empty or partial catalog');
  const c = await cycle(env);
  assert.equal(c.status, 'source_timeout');
  assert.ok(JSON.parse(c.missing).includes('catalog_refresh:rejected'));
  const calls = h.calls;
  await tick(env, h, '2026-09-22T09:30:00Z');
  assert.equal(h.calls, calls, 'no automatic retry after the cutoff');
  // The explicit fallback: an audited reuse approval resumes the same run.
  assert.equal((await admin(env, 'POST', `/v1/admin/cycles/${WEEK}/accept-catalog-reuse`, { reason: 'Sheet host unreachable all day; reuse the pinned catalog (test)' })).status, 200);
  await tick(env, h, '2026-09-22T09:45:00Z');
  const run = await runOf(env);
  assert.ok(['validated', 'blocked'].includes(run.state));
  assert.equal(JSON.parse(run.gate).catalog.freshness.status, 'reused_accepted');
});

test('C8 catalog: rejected content is not retried and never replaces the active catalog', async () => {
  for (const mode of ['html', 'shrunk']) {
    const env = await week(), h = host();
    const active = (await env.DB.prepare("SELECT catalog_rev FROM cost_catalog WHERE status = 'accepted' ORDER BY captured_at DESC LIMIT 1").first()).catalog_rev;
    h.mode = mode;
    const t = await tick(env, h, FIRST);
    const [r] = await refreshes(env);
    assert.equal(r.status, 'rejected', mode);
    assert.deepEqual(t.attempts[0].missing, ['catalog_refresh:rejected'], mode);
    const calls = h.calls;
    await tick(env, h, '2026-09-21T09:30:00Z');
    assert.equal(h.calls, calls, `${mode}: a rejection is not retried`);
    const now = (await env.DB.prepare("SELECT catalog_rev FROM cost_catalog WHERE status = 'accepted' ORDER BY captured_at DESC LIMIT 1").first()).catalog_rev;
    assert.equal(now, active, `${mode}: the active catalog is unchanged`);
    assert.deepEqual(leaks(await dbText(env) + JSON.stringify(t)), [], mode);
  }
});

test('C8 catalog: a fulfilled refresh or an audited reuse for the week means no automatic fetch', async () => {
  const env = await week(), h = host();
  assert.equal((await ingest(env, '/v1/ingest/shopify', viaNormalized({ mode: 'updated_since', nodes: [], weekStart: WEEK }))).status, 200);
  await tick(env, h, '2026-09-21T08:20:00Z');
  assert.equal(h.calls, 0, 'nothing before the first attempt');
  await withFetch(h.fetch, () => admin(env, 'POST', '/v1/admin/catalog/fetch', { weekStart: WEEK }));
  const calls = h.calls;
  const t = await tick(env, h, FIRST);
  assert.deepEqual([t.catalogRefresh.reason, h.calls], ['already_fulfilled', calls]);
});
