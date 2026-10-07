/**
 * Free-plan D1 budget (2026-10-06): the Worker meters its own D1 use per UTC day and defers background
 * work at a configurable share of the account's daily allowance, leaving headroom for dashboard sign-in
 * and browsing. Deferral is a distinct answer; the dashboard is never deferred.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, call, sessionCookie } from './helpers.mjs';
import { freeTierEnv, api, dataset, bridge, ORIGIN } from './freeTierHarness.mjs';
import { meteredDb, newMeter, recordUsage, budgetState, budgetConfig, backgroundScope, _resetBudgetCache, BUDGET_DEFAULTS } from '../src/usage.js';
import worker from '../src/index.js';
import { CURRENT_ENGINE_PENDING_SQL } from '../src/verifyRoutes.js';

/** The test D1 with D1-like meta: every row returned counts as read, every change as written. */
function withMeta(db) {
  const wrap = st => ({
    bind: (...a) => wrap(st.bind(...a)),
    first: async c => st.first(c),
    all: async () => { const r = await st.all(); return { ...r, meta: { ...r.meta, rows_read: (r.results || []).length, rows_written: 0 } }; },
    run: async () => { const r = await st.run(); return { ...r, meta: { ...r.meta, rows_read: 0, rows_written: r.meta?.changes || 0 } }; },
    _st: st,
  });
  return { prepare: sql => wrap(db.prepare(sql)), batch: async ss => (await db.batch(ss.map(s => s._st || s))).map(r => ({ ...r, meta: { ...r.meta, rows_read: (r.results || []).length, rows_written: r.meta?.changes || 0 } })), exec: q => db.exec(q), db: db.db };
}
const day = () => new Date().toISOString().slice(0, 10);
const setUsage = (env, scope, read, written) => env.DB.prepare(`INSERT INTO d1_usage (day, scope, rows_read, rows_written, requests) VALUES (?1, ?2, ?3, ?4, 1)
  ON CONFLICT(day, scope) DO UPDATE SET rows_read = excluded.rows_read, rows_written = excluded.rows_written`).bind(day(), scope, read, written).run();

test('budget: the meter sums rows read and written of every statement, first(), all(), run() and batch()', async () => {
  const env = await makeEnv();
  const meter = newMeter(), db = meteredDb(withMeta(env.DB), meter);
  await db.prepare("INSERT INTO settings_audit (key, old_value, new_value, reason, actor_class, actor_label, at) VALUES ('k', 'a', 'b', 'test reason', 'admin_secret', 't', 'x')").run().catch(() => {});
  const before = { ...meter };
  const n = (await db.prepare('SELECT key FROM settings').all()).results.length;
  const first = await db.prepare('SELECT key, value FROM settings ORDER BY key').first();
  const col = await db.prepare('SELECT key, value FROM settings ORDER BY key').first('key');
  assert.equal(col, first.key, 'first(col) keeps its meaning');
  const [a, b] = await db.batch([db.prepare('SELECT key FROM settings'), db.prepare('SELECT key FROM settings LIMIT 1')]);
  assert.ok(a.results.length === n && b.results.length === 1);
  assert.equal(meter.read - before.read, n + n + n + n + 1, 'first() counts the whole statement, as D1 does');
  assert.equal(backgroundScope('/v1/collect/weeks/2026-09-28/manifest'), 'background');
  assert.equal(backgroundScope('/v1/snapshot/2026-09-21/orders'), 'dashboard');
  assert.equal(backgroundScope('/v1/auth/login'), 'dashboard');
});

test('budget: defers at 60% of either daily allowance including the unmetered reserve, and at background caps', async () => {
  const env = await makeEnv();
  assert.deepEqual(budgetConfig(env), { ...BUDGET_DEFAULTS });
  assert.equal((await budgetState(env, env.DB)).state, 'ok');
  // 2.4M of 5M read in the dashboard (48%) + 10% reserve = 58%: ok. 2.5M (50% + 10%): defer.
  await setUsage(env, 'dashboard', 2_400_000, 0);
  assert.equal((await budgetState(env, env.DB)).state, 'ok');
  await setUsage(env, 'dashboard', 2_500_000, 0);
  const r = await budgetState(env, env.DB);
  assert.deepEqual([r.state, r.reasons], ['defer', ['daily_reads_threshold']]);
  assert.match(r.resetAt, /T00:00:00\.000Z$/);
  await setUsage(env, 'dashboard', 0, 0);
  await setUsage(env, 'background', 100, 50_000);
  assert.deepEqual((await budgetState(env, env.DB)).reasons, ['daily_writes_threshold', 'background_writes_cap']);
  await setUsage(env, 'background', 2_000_000, 0);
  assert.deepEqual((await budgetState({ ...env, BACKGROUND_DEFER_AT: '0.9' }, env.DB)).reasons, ['background_reads_cap'], 'configurable');
  // The account-wide figure (analytics), when configured, wins when it is larger: staging and console use count.
  await setUsage(env, 'background', 0, 0);
  const acct = { ...env, CF_ANALYTICS_TOKEN: 'x', CF_ACCOUNT_ID: '0'.repeat(32) };
  const fetchImpl = async () => new Response(JSON.stringify({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [{ sum: { rowsRead: 2_000_000, rowsWritten: 10 } }, { sum: { rowsRead: 600_000, rowsWritten: 0 } }] }] } } }));
  const a = await budgetState(acct, env.DB, { fetchImpl });
  assert.deepEqual([a.state, a.measured.source, a.measured.account.rowsRead], ['defer', 'worker_meter+account_analytics', 2_600_000]);
  const down = await budgetState(acct, env.DB, { fetchImpl: async () => { throw new Error('offline'); } });
  assert.deepEqual([down.state, down.measured.source], ['ok', 'worker_meter'], 'analytics unavailable: the meter and the reserve decide');
});

test('budget: requests record their D1 use per day and scope; background compute is refused while deferred, the dashboard is not', async () => {
  const env = await freeTierEnv();
  env.DB = withMeta(env.DB);
  _resetBudgetCache();
  await api(env, 'GET', '/v1/collect/weeks/2026-09-28/status', undefined, 'ingest');
  await api(env, 'GET', '/v1/collect/weeks/2026-09-28/status', undefined, 'ingest');
  const rows = (await env.DB.prepare('SELECT scope, rows_read, requests FROM d1_usage').all()).results;
  assert.ok(rows.some(r => r.scope === 'background' && r.requests >= 2 && r.rows_read > 0), JSON.stringify(rows));
  const cookie = await sessionCookie(env);
  await setUsage(env, 'dashboard', 2_600_000, 0);
  _resetBudgetCache();
  const b = await api(env, 'GET', '/v1/collect/budget', undefined, 'ingest');
  assert.equal(b.json.state, 'defer');
  const m = await api(env, 'GET', '/v1/collect/weeks/2026-09-28/manifest', undefined, 'ingest');
  assert.deepEqual([m.status, m.json.error], [503, 'background_deferred']);
  assert.match(m.json.detail.resetAt, /T00:00:00\.000Z$/);
  const v = await api(env, 'GET', '/v1/verify/snapshots/snp_00000000000000000000', undefined, 'verify');
  assert.equal(v.json.error, 'background_deferred');
  const dash = await call(env, 'GET', '/v1/weeks', { cookie });
  assert.equal(dash.status, 200, 'the dashboard is never deferred');
  _resetBudgetCache();
});

test('budget: the meter\'s own upserts are counted; unreadable usage fails closed for background work only', async () => {
  const env = await freeTierEnv();
  _resetBudgetCache();
  await setUsage(env, 'background', 1000, 10);
  await env.DB.prepare("UPDATE d1_usage SET requests = 500 WHERE scope = 'background'").run();
  const b = await budgetState(env, env.DB);
  assert.deepEqual([b.measured.rowsRead, b.measured.rowsWritten, b.measured.meterRequests], [1500, 510, 500], 'one read and one write per metered request');
  // d1_usage unreadable (e.g. the table missing): background work is refused, never treated as within budget.
  const cookie = await sessionCookie(env);
  await env.DB.prepare('DROP TABLE d1_usage').run();
  _resetBudgetCache();
  const budget = await api(env, 'GET', '/v1/collect/budget', undefined, 'ingest');
  assert.deepEqual([budget.status, budget.json.error], [503, 'budget_unavailable']);
  const m = await api(env, 'GET', '/v1/collect/weeks/2026-09-28/manifest', undefined, 'ingest');
  assert.deepEqual([m.status, m.json.error, m.json.detail.reasons], [503, 'background_deferred', ['budget_unavailable']]);
  assert.equal((await call(env, 'GET', '/v1/weeks', { cookie })).status, 200, 'the dashboard still works');
  _resetBudgetCache();
});

test('work check: one cheap answer — what is unfinished, and the budget', async () => {
  const env = await freeTierEnv();
  _resetBudgetCache();
  const w = await api(env, 'GET', '/v1/collect/work?week=2026-09-28', undefined, 'ingest');
  assert.equal(w.status, 200);
  assert.deepEqual(w.json.unfinished, ['week_sources_missing']);
  assert.equal(w.json.budget.state, 'ok');
  const { ENGINE_VERSION } = await import('../../shared/snapshot.js');
  await env.DB.prepare("INSERT INTO snapshot (snapshot_id, week_start, revision, status, computed_at, engine_version, policy, profitability_status, storage) VALUES ('snp_x', '2026-09-21', 1, 'draft', 't', ?1, '{}', 'ok', 'chunked')").bind(ENGINE_VERSION).run();
  assert.ok((await api(env, 'GET', '/v1/collect/work?week=2026-09-28', undefined, 'ingest')).json.unfinished.includes('verification_backlog'));
  await setUsage(env, 'dashboard', 3_000_000, 0);
  assert.equal((await api(env, 'GET', '/v1/collect/work?week=2026-09-28', undefined, 'ingest')).json.budget.state, 'defer');
  assert.equal((await api(env, 'GET', '/v1/collect/work?week=x', undefined, 'ingest')).status, 400);
  _resetBudgetCache();
});

test('work check: 20 older-engine drafts ahead of one current-engine draft do not hide it (engine filtered in SQL before LIMIT 1)', async () => {
  const env = await freeTierEnv();
  _resetBudgetCache();
  const { ENGINE_VERSION } = await import('../../shared/snapshot.js');
  const add = (id, week, engine) => env.DB.prepare("INSERT INTO snapshot (snapshot_id, week_start, revision, status, computed_at, engine_version, policy, profitability_status, storage) VALUES (?1, ?2, 1, 'draft', 't', ?3, '{}', 'ok', 'chunked')").bind(id, week, engine).run();
  const monday = i => new Date(Date.UTC(2026, 2, 2) + i * 7 * 86400000).toISOString().slice(0, 10);   // 2026-03-02 + i weeks
  for (let i = 0; i < 20; i++) await add(`snp_old_${i}`, monday(i), '2026.01.01-older');
  const work = async () => (await api(env, 'GET', '/v1/collect/work?week=2026-09-28', undefined, 'ingest')).json.unfinished;
  assert.ok(!(await work()).includes('verification_backlog'), 'older-engine drafts alone are not this engine\'s backlog');
  await add('snp_current', monday(20), ENGINE_VERSION);                                               // after all 20, in week order
  assert.ok((await work()).includes('verification_backlog'), 'the current-engine draft is found behind 20 older ones');
  // The lookup returns one row at most: the daily check never fetches the backlog.
  const rows = (await env.DB.prepare(CURRENT_ENGINE_PENDING_SQL).bind(ENGINE_VERSION).all()).results;
  assert.deepEqual(rows.map(r => r.snapshot_id), ['snp_current']);
  assert.match(CURRENT_ENGINE_PENDING_SQL, /engine_version = \?1[\s\S]*LIMIT 1\s*$/);
  // A newer revision of that week verified elsewhere (any engine) supersedes the draft: nothing pending.
  await env.DB.prepare("INSERT INTO snapshot (snapshot_id, week_start, revision, status, computed_at, engine_version, policy, profitability_status, storage) VALUES ('snp_current_r2', ?1, 2, 'draft', 't', '2026.01.01-older', '{}', 'ok', 'chunked')").bind(monday(20)).run();
  assert.ok(!(await work()).includes('verification_backlog'), 'only the newest revision of a week counts');
  _resetBudgetCache();
});
