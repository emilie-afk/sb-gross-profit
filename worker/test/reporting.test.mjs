/**
 * GET /v1/reporting/weeks — the Marketing Dashboard's read-only reporting credential (X-Reporting-Secret).
 * Synthetic snapshots only. Checks: its own credential and nothing else; published weeks only; completeness,
 * dates, timezone, scope and revision; pagination; no order, customer, catalog or credential data; revocation;
 * and that the browser proxy never exposes it. One case runs the real compute and publish path end to end.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createProxy } from '../../netlify/edge-functions/api-proxy.js';
import { makeEnv, loaded, admin, call, rnd, WEEK, PASSWORD } from './helpers.mjs';
import { signSession } from '../src/auth.js';
import { gateConfig, gateCookieHeader } from '../../tests/gate-fixture.mjs';

const rep = (env, q = '', secret = env.REPORTING_SECRET, headers = {}) =>
  call(env, 'GET', `/v1/reporting/weeks${q}`, { headers: { ...(secret ? { 'X-Reporting-Secret': secret } : {}), ...headers } });

let seq = 0;
async function snap(env, week, { revision = 1, status = 'published', profit = 100, revenue = 400, pstatus = 'complete', partialWeek = null } = {}) {
  const id = `snp_${(++seq).toString(16).padStart(20, '0')}`;
  await env.DB.prepare(`INSERT INTO snapshot (snapshot_id, week_start, revision, status, computed_at, engine_version, catalog_rev, policy, profitability_status, published_at, reason)
    VALUES (?1, ?2, ?3, ?4, '2026-10-01T00:00:00Z', 'test', 'cat-private-rev', '{"locked":true,"secretNote":"policy detail"}', ?5, ?6, 'internal reason text')`)
    .bind(id, week, revision, status, pstatus, status === 'published' ? '2026-10-02T00:00:00Z' : null).run();
  await env.DB.prepare(`INSERT INTO snapshot_totals (snapshot_id, operating_revenue, shopify_net_revenue_incl_pass_through, operating_gp_after_shipping, operating_gp_margin,
      route_collected, route_remitted, route_net, known_product_cogs, known_cost_product_revenue, known_cost_product_gp, known_cost_product_margin,
      missing_cost_revenue, missing_cost_units, missing_cost_lines, cost_coverage_by_revenue, cost_coverage_by_units, shipping_collected, shipping_expense,
      shipstation_expense, hpd_shipping_expense, orders_requiring_shipstation_rate, orders_with_valid_shipstation_rate, shipstation_expense_coverage,
      hpd_orders_actual, hpd_orders_pass_through, insurance_disclosed, profitability_status, labels, revenue_bridge)
    VALUES (?1, ?2, ?2, ?3, 25, 1, 1, 0, 200, ?2, 200, 50, 0, 0, 0, 100, 100, 20, 30, 30, 0, 10, 10, 100, 0, 0, 0, ?4, ?5, '{"orders":["#100001"]}')`)
    .bind(id, revenue, profit, pstatus, JSON.stringify(partialWeek ? { partialWeek } : {})).run();
  return id;
}
const weeks = ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28'];

test('reporting needs its own secret; other credentials never work, and it opens nothing else', async () => {
  const env = await makeEnv({ DASHBOARD_READER_SECRET: rnd(), VERIFY_SECRET: rnd(), GATE_SECRET: rnd() });
  assert.equal((await rep(env, '', 'x'.repeat(40))).json.error, 'reporting_not_configured', 'not enabled until the secret exists');
  env.REPORTING_SECRET = rnd();
  assert.equal((await rep(env, '', null)).status, 401);
  for (const other of [env.ADMIN_SECRET, env.INGEST_SECRET, env.DASHBOARD_READER_SECRET, env.VERIFY_SECRET, env.GATE_SECRET, 'x'.repeat(64)]) {
    assert.equal((await rep(env, '', other)).status, 401);
  }
  assert.equal((await rep(env, '', null, { 'X-Admin-Secret': env.ADMIN_SECRET })).status, 401, 'admin is not a reporting credential');
  // The reporting secret opens no other route, in any header.
  const R = env.REPORTING_SECRET;
  for (const [m, p, h] of [['GET', '/v1/weeks', 'X-Reporting-Secret'], ['GET', `/v1/snapshot/${WEEK}`, 'X-Reporting-Secret'], ['GET', `/v1/snapshot/${WEEK}/orders`, 'X-Reporting-Secret'],
    ['GET', '/v1/admin/settings', 'X-Admin-Secret'], ['GET', '/v1/weeks', 'X-Dashboard-Reader-Secret'], ['GET', '/v1/collect/budget', 'X-Ingest-Secret'],
    ['GET', '/v1/verify/pending', 'X-Verify-Secret'], ['POST', '/v1/gate/attempts', 'X-Gate-Secret']]) {
    const r = await call(env, m, p, { headers: { [h]: R } });
    assert.ok(r.status === 401 || r.status === 400, `${m} ${p} via ${h} → ${r.status}`);
  }
  assert.equal((await call(env, 'POST', '/v1/reporting/weeks', { headers: { 'X-Reporting-Secret': R } })).status, 404);
  assert.equal((await call(env, 'GET', '/v1/reporting/other', { headers: { 'X-Reporting-Secret': R } })).status, 404);
});

test('a reporting secret equal to any other secret fails closed: that value opens nothing', async () => {
  const base = await makeEnv({ DASHBOARD_READER_SECRET: rnd(), VERIFY_SECRET: rnd(), GATE_SECRET: rnd() });
  const uses = {
    ADMIN_SECRET: ['GET', '/v1/admin/settings', 'X-Admin-Secret'],
    INGEST_SECRET: ['GET', '/v1/collect/budget', 'X-Ingest-Secret'],
    VERIFY_SECRET: ['GET', '/v1/verify/pending', 'X-Verify-Secret'],
    DASHBOARD_READER_SECRET: ['GET', '/v1/weeks', 'X-Dashboard-Reader-Secret'],
    GATE_SECRET: ['GET', `/v1/gate/revocations/gat_${'0'.repeat(32)}`, 'X-Gate-Secret'],
  };
  for (const [name, [m, p, h]] of Object.entries(uses)) {
    const env = { ...base, REPORTING_SECRET: base[name] };
    const r = await rep(env, '', base[name]);
    assert.equal(r.status, 500, `reporting route, REPORTING_SECRET = ${name}`);
    assert.equal(r.json.error, 'misconfigured');
    const other = await call(env, m, p, { headers: { [h]: base[name], 'X-Gate-Session': `gat_${'1'.repeat(32)}` } });
    assert.equal(other.status, 500, `${name}'s own route refuses the shared value`);
    assert.equal(other.json.error, 'misconfigured');
  }
  // SESSION_SIGNING_KEY is a signing key, never a bearer; equal to it is refused on the reporting route too.
  assert.equal((await rep({ ...base, REPORTING_SECRET: base.SESSION_SIGNING_KEY }, '', base.SESSION_SIGNING_KEY)).status, 500);
});

// Regression: REPORTING_SECRET = SESSION_SIGNING_KEY let the reporting holder sign a session and read /v1/weeks.
test('a reporting secret equal to the session signing key: a session forged with it reads nothing, and sign-in is refused', async () => {
  const env = await makeEnv();
  await snap(env, weeks[0]);
  const ok = await call(env, 'GET', '/v1/weeks', { cookie: `sb_session=${(await signSession(env)).token}` });
  assert.equal(ok.status, 200, 'distinct secrets: a valid session reads');
  env.REPORTING_SECRET = env.SESSION_SIGNING_KEY;                       // the collision
  // The reporting holder knows this value, so they can sign a session with it.
  const { token } = await signSession({ SESSION_SIGNING_KEY: env.REPORTING_SECRET });
  for (const p of ['/v1/weeks', '/v1/history', `/v1/snapshot/${weeks[0]}`, '/v1/auth/session']) {
    const r = await call(env, 'GET', p, { cookie: `sb_session=${token}` });
    assert.equal(r.status, 500, p);
    assert.equal(r.json.error, 'misconfigured', p);
  }
  assert.equal((await call(env, 'POST', '/v1/auth/login', { body: { password: PASSWORD } })).status, 500, 'sign-in refused too');
  assert.equal((await call(env, 'GET', '/v1/admin/settings', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } })).status, 500, 'every route fails closed');
});

test('published weeks only, with dates, timezone, scope, completeness and revision; nothing private', async () => {
  const env = await makeEnv({ REPORTING_SECRET: rnd() });
  await snap(env, weeks[0], { pstatus: 'complete' });
  await snap(env, weeks[1], { pstatus: 'provisional_missing_costs_and_shipping' });
  await snap(env, weeks[2], { status: 'draft' });
  await snap(env, weeks[3], { status: 'blocked' });
  await snap(env, weeks[4], { revision: 1, status: 'superseded' });
  await snap(env, weeks[4], { revision: 2, status: 'published', pstatus: 'provisional_hpd_pass_through', partialWeek: { from: '2026-10-01', to: '2026-10-04', reportingStart: '2026-10-01' } });
  const r = await rep(env);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(r.json.weeks.map(w => w.period.week_start), [weeks[0], weeks[1], weeks[4]], 'drafts, blocked and superseded are never returned');
  const [a, b, c] = r.json.weeks;
  assert.deepEqual(a.period, { start: weeks[0], end: '2026-09-06', week_start: weeks[0], granularity: 'week', timezone: 'America/Los_Angeles' });
  assert.equal(a.id, `gp:week:${weeks[0]}`);
  assert.equal(a.scope.key, 'shopify_store');
  assert.equal(a.completeness, 'complete');
  assert.deepEqual(a.completeness_reasons, []);
  assert.deepEqual(a.totals, { gross_profit: 100, gross_profit_revenue_basis: 400, product_cost: 200, shipping_cost: 30, known_cost_product_revenue: 400,
    missing_cost_revenue: 0, missing_cost_lines: 0, cost_coverage_by_revenue_pct: 100, orders_requiring_shipping_cost: 10, orders_with_shipping_cost: 10 });
  assert.equal(b.completeness, 'provisional');
  assert.deepEqual(b.completeness_reasons, ['missing_product_costs', 'missing_shipping_costs']);
  assert.equal(c.revision, 2);
  assert.equal(c.completeness, 'partial');
  assert.deepEqual(c.completeness_reasons, ['assumed_dropship_shipping', 'partial_week']);
  assert.deepEqual(c.period, { start: '2026-10-01', end: '2026-10-04', week_start: weeks[4], granularity: 'custom', timezone: 'America/Los_Angeles' });
  // Nothing private: no order numbers, revenue bridge, policy, catalog, reasons, actors or secrets.
  const text = JSON.stringify(r.json);
  for (const s of ['#100001', 'secretNote', 'policy', 'cat-private-rev', 'internal reason', 'catalog', 'bridge', 'hold', env.REPORTING_SECRET, env.ADMIN_SECRET]) {
    assert.ok(!text.includes(s), `response must not contain ${s}`);
  }
  assert.deepEqual(Object.keys(a).sort(), ['completeness', 'completeness_reasons', 'computed_at', 'currency', 'id', 'period', 'published_at', 'revision', 'scope', 'snapshot_id', 'totals']);
});

test('a later published revision keeps the record id with a higher revision; the store timezone setting is used', async () => {
  const env = await makeEnv({ REPORTING_SECRET: rnd() });
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('store_timezone', ?1, '2026-10-01T00:00:00Z')").bind(JSON.stringify('America/New_York')).run();
  const first = await snap(env, weeks[0]);
  const r1 = (await rep(env)).json.weeks[0];
  await env.DB.prepare("UPDATE snapshot SET status = 'superseded' WHERE snapshot_id = ?1").bind(first).run();
  await snap(env, weeks[0], { revision: 2, profit: 120 });
  const r2 = (await rep(env)).json.weeks[0];
  assert.equal(r2.id, r1.id);
  assert.equal(r2.revision, 2);
  assert.notEqual(r2.snapshot_id, r1.snapshot_id);
  assert.equal(r2.totals.gross_profit, 120);
  assert.equal(r2.period.timezone, 'America/New_York');
});

test('pagination, date filters and parameter checks', async () => {
  const env = await makeEnv({ REPORTING_SECRET: rnd() });
  for (const w of weeks) await snap(env, w);
  const p1 = (await rep(env, '?limit=2')).json;
  assert.deepEqual(p1.weeks.map(w => w.period.week_start), weeks.slice(0, 2));
  const p2 = (await rep(env, `?limit=2&cursor=${p1.next_cursor}`)).json;
  assert.deepEqual(p2.weeks.map(w => w.period.week_start), weeks.slice(2, 4));
  const p3 = (await rep(env, `?limit=2&cursor=${p2.next_cursor}`)).json;
  assert.deepEqual(p3.weeks.map(w => w.period.week_start), weeks.slice(4));
  assert.equal(p3.next_cursor, null);
  assert.deepEqual((await rep(env, `?from=${weeks[1]}&to=${weeks[3]}`)).json.weeks.map(w => w.period.week_start), weeks.slice(1, 4));
  for (const q of ['?limit=0', '?limit=53', '?from=2026-9-1', '?cursor=x', `?from=${weeks[3]}&to=${weeks[1]}`, '?includeDrafts=1', '?provisional=1']) {
    assert.equal((await rep(env, q)).status, 400, q);
  }
});

test('revoking: deleting the secret disables reporting at once', async () => {
  const env = await makeEnv({ REPORTING_SECRET: rnd() });
  await snap(env, weeks[0]);
  const old = env.REPORTING_SECRET;
  assert.equal((await rep(env)).status, 200);
  delete env.REPORTING_SECRET;
  assert.equal((await rep(env, '', old)).status, 503);
  env.REPORTING_SECRET = rnd();
  assert.equal((await rep(env, '', old)).status, 401, 'a rotated secret replaces the old one');
});

test('the browser proxy never exposes the reporting route', async () => {
  const env = await makeEnv({ REPORTING_SECRET: rnd(), DASHBOARD_READER_SECRET: rnd() });
  const g = gateConfig();
  const record = [];
  const proxy = createProxy({ workerOrigin: 'https://w.example', readerSecret: env.DASHBOARD_READER_SECRET, ...g, fetchImpl: async req => { record.push(req); return worker.fetch(req, env); } });
  const res = await proxy(new Request('https://sb-profit.netlify.app/api/v1/reporting/weeks', { headers: { cookie: await gateCookieHeader(g), 'x-reporting-secret': env.REPORTING_SECRET } }));
  assert.equal(res.status, 404);
  assert.equal(record.length, 0);
});

test('end to end: a week computed and published by the real path is reported', async () => {
  const { env } = await loaded(5, { PUBLICATION_ALLOWED: 'true' });
  await admin(env, 'POST', '/v1/admin/settings', { publication_enabled: true, reason: 'test go-live' });
  env.REPORTING_SECRET = rnd();
  assert.equal((await rep(env)).json.weeks.length, 0, 'a draft is not reported');
  const run = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  assert.equal(run.status, 200, JSON.stringify(run.json));
  assert.equal((await admin(env, 'POST', '/v1/admin/publish', { snapshotId: run.json.snapshotId })).status, 200);
  const [w] = (await rep(env)).json.weeks;
  const pub = (await admin(env, 'GET', `/v1/snapshot/${WEEK}`)).json;
  assert.equal(w.snapshot_id, run.json.snapshotId);
  assert.equal(w.period.week_start, WEEK);
  assert.equal(w.totals.gross_profit, pub.totals.operatingGpAfterShipping);
  assert.equal(w.totals.gross_profit_revenue_basis, pub.totals.operatingRevenue);
  assert.equal(w.completeness === 'complete', pub.totals.profitabilityStatus === 'complete');
});

test('rotation: REPORTING_SECRET_NEXT is accepted alongside the current key, held to the same rules, and revocable', async () => {
  const env = await makeEnv({ DASHBOARD_READER_SECRET: rnd(), VERIFY_SECRET: rnd(), GATE_SECRET: rnd() });
  const oldKey = rnd(), newKey = rnd();
  // A first rotation can start with no current key.
  env.REPORTING_SECRET_NEXT = newKey;
  assert.equal((await rep(env, '', newKey)).status, 200, 'the next key alone works');
  assert.equal((await rep(env, '', oldKey)).status, 401);
  // Overlap: both keys read, anything else is refused.
  env.REPORTING_SECRET = oldKey;
  assert.equal((await rep(env, '', oldKey)).status, 200);
  assert.equal((await rep(env, '', newKey)).status, 200);
  assert.equal((await rep(env, '', rnd())).status, 401);
  assert.equal((await rep(env, '', null)).status, 401);
  // Promotion: both equal for a moment, then NEXT is deleted; the old key stops working.
  env.REPORTING_SECRET = newKey;
  assert.equal((await rep(env, '', newKey)).status, 200, 'equal current and next keys are fine');
  delete env.REPORTING_SECRET_NEXT;
  assert.equal((await rep(env, '', newKey)).status, 200);
  assert.equal((await rep(env, '', oldKey)).status, 401, 'the old key is revoked');
  // A short next key, or one equal to any other secret, fails closed for every route.
  env.REPORTING_SECRET_NEXT = 'short';
  assert.equal((await rep(env, '', newKey)).status, 500);
  for (const k of ['ADMIN_SECRET', 'INGEST_SECRET', 'SESSION_SIGNING_KEY', 'VERIFY_SECRET', 'DASHBOARD_READER_SECRET', 'GATE_SECRET']) {
    env.REPORTING_SECRET_NEXT = env[k];
    assert.equal((await rep(env, '', env[k])).status, 500, `${k} as next key: reporting refused`);
    assert.equal((await call(env, 'GET', '/v1/admin/settings', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } })).status, 500, `${k} as next key: admin refused too`);
  }
  delete env.REPORTING_SECRET_NEXT;
  assert.equal((await rep(env, '', newKey)).status, 200, 'works again once the collision is gone');
});

test('rotation: the response names the slot that matched (1, 2 or both), never a key', async () => {
  const env = await makeEnv({ DASHBOARD_READER_SECRET: rnd(), VERIFY_SECRET: rnd(), GATE_SECRET: rnd() });
  const a = rnd(), b = rnd();
  env.REPORTING_SECRET = a;
  assert.equal((await rep(env, '', a)).headers.get('x-reporting-key-slot'), '1');
  env.REPORTING_SECRET_NEXT = b;
  assert.equal((await rep(env, '', b)).headers.get('x-reporting-key-slot'), '2');
  assert.equal((await rep(env, '', a)).headers.get('x-reporting-key-slot'), '1');
  env.REPORTING_SECRET_NEXT = a;
  assert.equal((await rep(env, '', a)).headers.get('x-reporting-key-slot'), '1,2');
  const refused = await rep(env, '', rnd());
  assert.equal(refused.status, 401);
  assert.equal(refused.headers.get('x-reporting-key-slot'), null);
});
