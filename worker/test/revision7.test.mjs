/**
 * Revision 7 acceptance tests (Worker level, D1 stand-in). All data synthetic.
 * Real-D1 concurrency is covered in workerd-integration.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WEEK, makeEnv, call, ingest, admin, catalog, weekOrders, loaded } from './helpers.mjs';
import { computeWeek } from '../src/compute.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const goLive = env => admin(env, 'POST', '/v1/admin/settings', { publication_enabled: true, reason: 'test go-live' });
const one = async (env, sql, ...p) => env.DB.prepare(sql).bind(...p).first();
const all = async (env, sql, ...p) => (await env.DB.prepare(sql).bind(...p).all()).results;
const updated = env => ingest(env, '/v1/ingest/shopify', { format: 'graphql', mode: 'updated_since', nodes: [], weekStart: WEEK });
const schedule = (env, label = 'make:S4') => admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK, trigger: 'schedule', actorLabel: label });

// ─── Confirmed store time zone ────────────────────────────────────────────────

test('the store time zone is recorded as confirmed America/Los_Angeles, with an audited reason', async () => {
  const env = await makeEnv();
  const s = (await admin(env, 'GET', '/v1/admin/settings')).json.settings;
  assert.deepEqual([s.store_timezone, s.store_timezone_confirmed, s.schedule_timezone, s.schedule_time, s.schedule_weekday],
                   ['America/Los_Angeles', true, 'Asia/Ho_Chi_Minh', '15:30', 1]);
  // Publication controls remain off in the delivered migrations.
  assert.deepEqual([s.publication_enabled, s.carrier_fee_priority_locked], [false, false]);
  const a = await one(env, "SELECT * FROM settings_audit WHERE key = 'store_timezone_confirmed'");
  assert.deepEqual([a.new_value, a.reason, a.actor_class], ['true', 'Confirmed from Shopify store settings: Pacific Time (US)', 'migration']);
});

test('publication gets past the time-zone check only while the zone is confirmed; nothing overrides it', async () => {
  const { env } = await loaded(20, { PUBLICATION_ALLOWED: 'true' });
  await goLive(env);                                                        // carrier lock ON (loaded), both switches ON
  const r = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  assert.equal(r.json.state, 'validated');
  assert.deepEqual([r.json.gate.storeTimezone, r.json.gate.storeTimezoneConfirmed], ['America/Los_Angeles', true]);

  await admin(env, 'POST', '/v1/admin/settings', { store_timezone_confirmed: false, reason: 'recheck Shopify settings (test)' });
  const p1 = await admin(env, 'POST', '/v1/admin/publish', { snapshotId: r.json.snapshotId });
  assert.deepEqual([p1.status, p1.json.detail.reason], [409, 'store_timezone_unconfirmed']);
  const blocked = await admin(env, 'POST', `/v1/admin/runs/${r.json.runId}/compute`, { reason: 'unconfirmed zone (test)' });
  assert.ok(blocked.json.gate.failures.some(f => f.code === 'store_timezone_unconfirmed'));   // a blocking gate failure too
  assert.equal(blocked.json.state, 'blocked');

  await admin(env, 'POST', '/v1/admin/settings', { store_timezone_confirmed: true, reason: 'Confirmed from Shopify store settings: Pacific Time (US)' });
  const r2 = await admin(env, 'POST', `/v1/admin/runs/${r.json.runId}/compute`, { reason: 'reconfirmed (test)' });
  assert.equal(r2.json.state, 'validated');
  const p2 = await admin(env, 'POST', '/v1/admin/publish', { snapshotId: r2.json.snapshotId });
  assert.equal(p2.status, 200, JSON.stringify(p2.json));
});

test('changing store_timezone clears the confirmation unless the same operation confirms it', async () => {
  const { env } = await loaded(20, { PUBLICATION_ALLOWED: 'true' });
  await goLive(env);
  const r = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  await admin(env, 'POST', '/v1/admin/settings', { store_timezone: 'America/Phoenix', reason: 'typo test' });
  let s = (await admin(env, 'GET', '/v1/admin/settings')).json.settings;
  assert.deepEqual([s.store_timezone, s.store_timezone_confirmed], ['America/Phoenix', false]);
  const auto = await one(env, "SELECT reason, actor_class FROM settings_audit WHERE key = 'store_timezone_confirmed' ORDER BY id DESC LIMIT 1");
  assert.match(auto.reason, /^automatic: store_timezone changed to America\/Phoenix; reconfirmation required$/);
  const p1 = await admin(env, 'POST', '/v1/admin/publish', { snapshotId: r.json.snapshotId });
  assert.deepEqual([p1.status, p1.json.detail.reason], [409, 'store_timezone_unconfirmed']);

  // Confirming a different zone in the same call is allowed, but a snapshot computed
  // in the old zone still cannot be published: its week boundaries are different.
  await admin(env, 'POST', '/v1/admin/settings', { store_timezone: 'America/Denver', store_timezone_confirmed: true, reason: 'zone test (test)' });
  s = (await admin(env, 'GET', '/v1/admin/settings')).json.settings;
  assert.deepEqual([s.store_timezone, s.store_timezone_confirmed], ['America/Denver', true]);
  const p2 = await admin(env, 'POST', '/v1/admin/publish', { snapshotId: r.json.snapshotId });
  assert.deepEqual([p2.status, p2.json.detail.reason], [409, 'store_timezone_changed']);

  // Setting the SAME zone again does not clear the confirmation.
  await admin(env, 'POST', '/v1/admin/settings', { store_timezone: 'America/Los_Angeles', store_timezone_confirmed: true, reason: 'back to Pacific (test)' });
  await admin(env, 'POST', '/v1/admin/settings', { store_timezone: 'America/Los_Angeles', reason: 'no-op (test)' });
  assert.equal((await admin(env, 'GET', '/v1/admin/settings')).json.settings.store_timezone_confirmed, true);
  assert.equal((await admin(env, 'POST', '/v1/admin/publish', { snapshotId: r.json.snapshotId })).status, 200);
});

test('Pacific DST weeks come from the confirmed IANA zone through the readiness API', async () => {
  const env = await makeEnv();
  for (const [w, s, e, h] of [['2026-03-02', '2026-03-02T08:00:00.000Z', '2026-03-09T07:00:00.000Z', 167],
                              ['2026-10-26', '2026-10-26T07:00:00.000Z', '2026-11-02T08:00:00.000Z', 169],
                              ['2026-09-14', '2026-09-14T07:00:00.000Z', '2026-09-21T07:00:00.000Z', 168]]) {
    const r = (await admin(env, 'GET', `/v1/admin/readiness?weekStart=${w}`)).json;
    assert.deepEqual([r.window.startUtc, r.window.endUtcExclusive, r.window.hours], [s, e, h], w);
    assert.equal(new Date(r.scheduledAt).toISOString().slice(11, 16), '08:30');   // 15:30 Ho Chi Minh, every season
  }
});

// ─── Scheduled-week ownership ─────────────────────────────────────────────────

test('two simultaneous scheduled computes create one cycle, one run and one snapshot', async () => {
  const { env } = await loaded(20);
  await updated(env);
  const [a, b] = await Promise.all([schedule(env, 'make:S4a'), schedule(env, 'make:S4b')]);
  assert.deepEqual([a.status, b.status], [200, 200], JSON.stringify([a.json, b.json]));
  assert.equal(a.json.runId, b.json.runId);
  assert.equal([a.json, b.json].filter(x => x.existing).length, 1);
  assert.equal((await one(env, 'SELECT COUNT(*) AS n FROM schedule_cycle')).n, 1);
  assert.equal((await one(env, "SELECT COUNT(*) AS n FROM reporting_run WHERE trigger = 'schedule'")).n, 1);
  assert.equal((await one(env, 'SELECT COUNT(*) AS n FROM snapshot WHERE week_start = ?1', WEEK)).n, 1);
  assert.equal((await one(env, "SELECT COUNT(*) AS n FROM reporting_run WHERE state IN ('created','computing')")).n, 0);
});

test('a scheduled cycle that failed is resumed in place: same run, no second scheduled run', async () => {
  const { env } = await loaded(20);
  await updated(env);
  env.DB.failNextBatchAt(/INSERT INTO snapshot \(/);
  const first = await schedule(env);
  assert.equal(first.status, 500);
  const run1 = await one(env, "SELECT run_id, state FROM reporting_run WHERE trigger = 'schedule'");
  assert.equal(run1.state, 'failed');
  assert.equal((await one(env, 'SELECT last_error FROM schedule_cycle')).last_error, 'compute_failed');
  const second = await schedule(env);
  assert.equal(second.status, 200, JSON.stringify(second.json));
  assert.deepEqual([second.json.runId, second.json.resumed, second.json.cycle.attempts], [run1.run_id, true, 2]);
  assert.equal((await one(env, "SELECT COUNT(*) AS n FROM reporting_run WHERE trigger = 'schedule'")).n, 1);
  assert.equal((await one(env, 'SELECT COUNT(*) AS n FROM snapshot')).n, 1);
  assert.equal((await one(env, 'SELECT last_error FROM schedule_cycle')).last_error, null);
  const third = await schedule(env);
  assert.deepEqual([third.json.runId, third.json.existing], [run1.run_id, true]);
});

test('an interrupted claim (run stuck in created or computing) is resumed only once it is stale', async () => {
  for (const stuck of ['created', 'computing']) {
    const { env } = await loaded(20);
    await updated(env);
    const ok = await schedule(env);
    // Simulate a request that claimed the week and then died mid-way.
    await env.DB.prepare('DELETE FROM snapshot').run();
    await env.DB.prepare('UPDATE reporting_run SET state = ?2, snapshot_id = NULL, updated_at = ?3 WHERE run_id = ?1')
      .bind(ok.json.runId, stuck, new Date().toISOString()).run();
    const live = await schedule(env);
    assert.deepEqual([live.json.existing, live.json.inProgress], [true, true], stuck);       // fresh: someone may still be working
    await env.DB.prepare('UPDATE reporting_run SET updated_at = ?2 WHERE run_id = ?1').bind(ok.json.runId, '2026-01-01T00:00:00.000Z').run();
    const resumed = await schedule(env);
    assert.equal(resumed.status, 200, JSON.stringify(resumed.json));
    assert.deepEqual([resumed.json.runId, resumed.json.resumed], [ok.json.runId, true], stuck);
    assert.equal((await one(env, "SELECT COUNT(*) AS n FROM reporting_run WHERE trigger = 'schedule'")).n, 1);
    assert.equal((await one(env, "SELECT COUNT(*) AS n FROM reporting_run WHERE state IN ('created','computing')")).n, 0);
    assert.equal((await one(env, 'SELECT COUNT(*) AS n FROM snapshot')).n, 1);
  }
});

test('a request that lost ownership of the cycle cannot write a snapshot or touch the run', async () => {
  const { env } = await loaded(20);
  await updated(env);
  const ok = await schedule(env);
  await env.DB.prepare("UPDATE reporting_run SET state = 'failed' WHERE run_id = ?1").bind(ok.json.runId).run();
  const before = (await one(env, 'SELECT COUNT(*) AS n FROM snapshot')).n;
  await assert.rejects(computeWeek(env, { runId: ok.json.runId, trigger: 'schedule', actor: { cls: 'admin_secret', label: null },
                                          ownership: { weekStart: WEEK, token: 'clm_not_the_owner' } }),
                       e => e.code === 'ownership_lost');
  assert.equal((await one(env, 'SELECT COUNT(*) AS n FROM snapshot')).n, before);
});

// ─── Catalog refresh: a push resolves only the exact refresh it names ─────────

test('catalog pushes resolve only a valid, pending, unexpired refresh they name', async () => {
  const env = await makeEnv();
  const mk = async w => (await admin(env, 'POST', '/v1/admin/catalog-refresh', { weekStart: w })).json.refreshId;
  const a = await mk(WEEK), b = await mk('2026-09-21');
  const push = async refreshId => { const c = catalog(); if (refreshId !== undefined) c.meta.refreshId = refreshId; return (await ingest(env, '/v1/ingest/catalog', c)).json.refresh; };
  const status = async id => (await admin(env, 'GET', `/v1/admin/catalog-refresh/${id}`)).json.status;

  assert.equal((await push(undefined)).status, 'none');                              // build with no refreshId
  assert.equal((await push('crf_' + 'z'.repeat(20))).status, 'invalid');             // malformed
  assert.equal((await push('crf_0123456789abcdef0123; DROP')).status, 'invalid');
  assert.equal((await push('crf_00000000000000000000')).status, 'unknown');          // well-formed, not ours
  assert.deepEqual([await status(a), await status(b)], ['pending', 'pending']);      // none of those resolved anything

  assert.equal((await push(a)).status, 'fulfilled');                                  // exact id → only that refresh
  assert.deepEqual([await status(a), await status(b)], ['fulfilled', 'pending']);     // the unrelated cycle is untouched
  assert.equal((await push(a)).status, 'fulfilled');                                  // re-push: reported, unchanged
  await env.DB.prepare('UPDATE catalog_refresh SET requested_at = ?2 WHERE refresh_id = ?1').bind(b, '2026-01-01T00:00:00.000Z').run();
  assert.equal((await push(b)).status, 'expired');                                    // too late: not fulfilled
  assert.equal(await status(b), 'expired');
  const c = await mk('2026-09-28');
  const shrunk = catalog({ calathea: 300 }); shrunk.meta.refreshId = c;
  assert.equal((await ingest(env, '/v1/ingest/catalog', shrunk)).json.refresh.status, 'rejected');
});

test('build.py reads the refresh id from the Netlify INCOMING_HOOK_BODY exactly as Make sends it', () => {
  const py = `
import json, sys
sys.path.insert(0, ${JSON.stringify(REPO)})
from catalog_hook import refresh_id_from_hook_body as f
cases = [
  ('{"refreshId":"crf_0123456789abcdef0123","weekStart":"2026-09-14"}', 'crf_0123456789abcdef0123'),
  ('{ "weekStart": "2026-09-14", "refreshId": "crf_0123456789abcdef0123" }', 'crf_0123456789abcdef0123'),
  ('', None), ('not json', None), ('[]', None), ('{"refreshId": 5}', None),
  ('{"refreshId":"crf_0123456789ABCDEF0123"}', None), ('{"refreshId":"crf_0123456789abcdef0123x"}', None),
  ('{"refresh_id":"crf_0123456789abcdef0123"}', None),
]
print(json.dumps([f(raw) == want for raw, want in cases]))`;
  const out = JSON.parse(execFileSync('python3', ['-c', py], { encoding: 'utf8' }));
  assert.ok(out.every(Boolean), JSON.stringify(out));
});

// ─── Actor semantics ──────────────────────────────────────────────────────────

test('audit actors are server-assigned classes; labels are optional, unverified and never emails', async () => {
  const { env } = await loaded(20);
  assert.equal((await admin(env, 'POST', '/v1/admin/settings', { ss_coverage_threshold: 0.95, reason: 'test change', actor: 'Duc' })).status, 400);
  assert.equal((await admin(env, 'POST', '/v1/admin/settings', { ss_coverage_threshold: 0.95, reason: 'test change', actorLabel: 'duc@example.invalid' })).status, 400);
  const ok = await admin(env, 'POST', '/v1/admin/settings', { ss_coverage_threshold: 0.95, reason: 'test change', actorLabel: 'duc' });
  assert.deepEqual([ok.json.actorClass, ok.json.actorLabel], ['admin_secret', 'duc']);
  const a = await one(env, "SELECT actor_class, actor_label FROM settings_audit WHERE key = 'ss_coverage_threshold'");
  assert.deepEqual([a.actor_class, a.actor_label], ['admin_secret', 'duc']);

  const r = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  const tr = await all(env, 'SELECT to_state, actor_class, actor_label FROM run_transition WHERE run_id = ?1 ORDER BY seq', r.json.runId);
  assert.deepEqual(tr.map(t => [t.to_state, t.actor_class]),
    [['created', 'admin_secret'], ['computing', 'admin_secret'], ['draft', 'worker'], ['validated', 'worker']]);
  const rf = await one(env, 'SELECT requested_by_class FROM catalog_refresh LIMIT 1');
  assert.equal(rf.requested_by_class, 'admin_secret');
  for (const t of ['settings_audit', 'cost_restatement', 'catalog_reuse_acceptance', 'run_transition']) {
    const cols = (await all(env, `SELECT name FROM pragma_table_info('${t}')`)).map(c => c.name);
    assert.ok(cols.includes('actor_class') && cols.includes('actor_label') && !cols.includes('actor'), t);
  }
});

test('catalog-pushes lists each push and the refresh it resolved; staging can shorten the session TTL', async () => {
  const env = await makeEnv({ SESSION_TTL_SECONDS: '60' });
  const since = new Date(Date.now() - 1000).toISOString();
  const rf = (await admin(env, 'POST', '/v1/admin/catalog-refresh', { weekStart: WEEK })).json.refreshId;
  const c = catalog(); c.meta.refreshId = rf;
  await ingest(env, '/v1/ingest/catalog', c);
  await ingest(env, '/v1/ingest/catalog', catalog());
  const pushes = (await admin(env, 'GET', `/v1/admin/catalog-pushes?since=${encodeURIComponent(since)}`)).json.pushes;
  assert.deepEqual(pushes.map(p => p.refresh?.status).sort(), ['fulfilled', 'none']);
  const login = await call(env, 'POST', '/v1/auth/login', { body: { password: (await import('./helpers.mjs')).PASSWORD } });
  assert.match(login.headers.get('Set-Cookie'), /Max-Age=60$/);
  const prod = await makeEnv();
  const l2 = await call(prod, 'POST', '/v1/auth/login', { body: { password: (await import('./helpers.mjs')).PASSWORD } });
  assert.match(l2.headers.get('Set-Cookie'), /Max-Age=43200$/);
});

// ─── Review follow-ups ────────────────────────────────────────────────────────

test('a zone change plus recompute cannot publish orders bucketed in the old zone', async () => {
  const { env } = await loaded(20, { PUBLICATION_ALLOWED: 'true' });
  await goLive(env);
  const r = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  assert.equal(r.json.state, 'validated');
  await admin(env, 'POST', '/v1/admin/settings', { store_timezone: 'Asia/Tokyo', store_timezone_confirmed: true, reason: 'zone test (test)' });
  const r2 = await admin(env, 'POST', `/v1/admin/runs/${r.json.runId}/compute`, { reason: 'after zone change' });
  assert.equal(r2.json.state, 'blocked');
  assert.ok(r2.json.gate.failures.some(f => f.code === 'orders_in_other_timezone'));
  assert.equal((await admin(env, 'POST', '/v1/admin/publish', { snapshotId: r2.json.snapshotId })).status, 409);
  // Pre-normalized orders must declare the current store zone.
  const bad = await ingest(env, '/v1/ingest/shopify', { format: 'normalized', storeTimezone: 'America/Los_Angeles', orders: [] });
  assert.deepEqual([bad.status, bad.json.error], [400, 'timezone_mismatch']);
});

test('a stale draft, or a created run whose first attempt recorded an error, is resumed', async () => {
  const { env } = await loaded(20);
  await updated(env);
  const ok = await schedule(env);
  await env.DB.prepare('DELETE FROM snapshot').run();
  await env.DB.prepare("UPDATE reporting_run SET state = 'draft', updated_at = '2026-01-01T00:00:00.000Z' WHERE run_id = ?1").bind(ok.json.runId).run();
  const a = await schedule(env);
  assert.deepEqual([a.json.runId, a.json.resumed, a.json.state], [ok.json.runId, true, 'validated']);
  await env.DB.prepare('DELETE FROM snapshot').run();
  await env.DB.prepare("UPDATE reporting_run SET state = 'created', updated_at = ?2 WHERE run_id = ?1").bind(ok.json.runId, new Date().toISOString()).run();
  await env.DB.prepare("UPDATE schedule_cycle SET last_error = 'compute_failed'").run();
  const b = await schedule(env);
  assert.deepEqual([b.json.runId, b.json.resumed], [ok.json.runId, true]);            // not "in progress" for 15 minutes
  assert.equal((await one(env, "SELECT COUNT(*) AS n FROM reporting_run WHERE trigger = 'schedule'")).n, 1);
});

test('backfill refuses a caller-asserted actor before computing anything', async () => {
  const { env } = await loaded(5);
  const r = await admin(env, 'POST', '/v1/admin/backfill', { from: '2026-09-01', today: '2026-09-24', dryRun: false, actor: 'Duc' });
  assert.deepEqual([r.status, r.json.error], [400, 'bad_payload']);
  assert.equal((await one(env, 'SELECT COUNT(*) AS n FROM snapshot')).n, 0);
});
