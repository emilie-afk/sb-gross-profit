/**
 * Dashboard → Netlify edge proxy (/api/v1) → Worker, end to end in-process.
 * The proxy module is the file Netlify deploys; the upstream is the real Worker handler on a D1 stand-in.
 * One sign-in: the site-password gate's signed session (shared/gateSession.js). The Worker's own sign-in
 * routes are not proxied. A deploy-preview run against the real Netlify edge is tools/proxy-smoke.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import worker from '../src/index.js';
import { signSession } from '../src/auth.js';
import { createProxy } from '../../netlify/edge-functions/api-proxy.js';
import { workerApi } from '../../js/workerClient.js';
import { PASSWORD, WEEK, makeEnv, loaded, admin, call, rnd, sessionCookie } from './helpers.mjs';
import { gateConfig, gateToken, gateCookieHeader } from '../../tests/gate-fixture.mjs';

const SITE = 'https://sb-profit.netlify.app';
const WORKER = 'https://sb-gp-worker.example.workers.dev';

/** A signed-in browser stand-in: same-origin fetch through the proxy with a gate session cookie. */
async function browser(env, { record, g = gateConfig() } = {}) {
  env.DASHBOARD_READER_SECRET ||= rnd();
  const proxy = createProxy({ workerOrigin: WORKER, readerSecret: env.DASHBOARD_READER_SECRET, ...g,
    fetchImpl: async req => { record?.push(req); return worker.fetch(req, env); } });
  const cookie = await gateCookieHeader(g);
  const fetchImpl = (path, init = {}) => {
    const headers = new Headers(init.headers || {});
    if (init.credentials !== 'omit') headers.set('cookie', cookie);
    return proxy(new Request(`${SITE}${path}`, { ...init, headers }));
  };
  return { fetchImpl, proxy, cookie, g };
}

test('A7: the Worker sign-in routes are not proxied; direct Worker sessions still expire and revoke', async () => {
  const env = await makeEnv();
  const record = [];
  const b = await browser(env, { record });
  for (const [m, p] of [['POST', '/api/v1/auth/login'], ['POST', '/api/v1/auth/logout'], ['GET', '/api/v1/auth/session']]) {
    const res = await b.proxy(new Request(`${SITE}${p}`, { method: m, headers: { cookie: b.cookie, origin: SITE }, body: m === 'POST' ? JSON.stringify({ password: PASSWORD }) : undefined }));
    assert.equal(res.status, 404, `${m} ${p}`);
  }
  assert.equal(record.length, 0, 'nothing reached the Worker');
  // Directly on the Worker: login, revocation of a copied cookie on logout, expiry.
  const cookie = await sessionCookie(env);
  assert.equal((await call(env, 'GET', '/v1/auth/session', { cookie })).status, 200);
  assert.equal((await call(env, 'POST', '/v1/auth/logout', { cookie })).status, 200);
  assert.equal((await call(env, 'GET', '/v1/auth/session', { cookie })).status, 401, 'a copied cookie is revoked server-side');
  const { token } = await signSession(env, { now: Date.now() - 13 * 3600_000 });
  assert.equal((await call(env, 'GET', '/v1/auth/session', { cookie: `sb_session=${token}` })).json.error, 'session_expired');
});

test('the proxy exposes read routes only and forwards no cookie, secret or client header', async () => {
  const { env } = await loaded(5);
  assert.equal((await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK })).status, 200);
  const record = [];
  const b = await browser(env, { record });
  for (const [m, p] of [['GET', '/api/v1/admin/settings'], ['POST', '/api/v1/admin/publish'], ['POST', '/api/v1/ingest/shopify'],
                        ['GET', '/api/v1/ingest/week-plan'], ['GET', '/api/v1/health/../admin/storage'], ['POST', '/api/v1/gate/attempts'],
                        ['GET', `/api/v1/gate/revocations/gat_${'0'.repeat(32)}`], ['POST', '/api/v1/weeks'], ['GET', '/api/v1/collect/budget']]) {
    const res = await b.proxy(new Request(`${SITE}${p}`, { method: m, headers: { cookie: b.cookie, origin: SITE, 'x-admin-secret': env.ADMIN_SECRET, 'x-ingest-secret': env.INGEST_SECRET } }));
    assert.equal(res.status, 404, `${m} ${p}`);
  }
  assert.equal(record.length, 0);
  // An admin secret, a Worker session and forwarded-for headers sent by a browser are all stripped: drafts stay invisible.
  const drafts = await b.proxy(new Request(`${SITE}/api/v1/snapshot/${WEEK}?includeDrafts=1`, { headers: {
    cookie: `${b.cookie}; sb_session=${(await signSession(env)).token}`, 'x-admin-secret': env.ADMIN_SECRET, 'x-forwarded-for': '198.51.100.9', 'x-gate-session': `gat_${'1'.repeat(32)}` } }));
  assert.deepEqual([drafts.status, (await drafts.json()).error], [404, 'not_published']);
  const req = record.at(-1);
  assert.ok(req.url.startsWith(`${WORKER}/v1/`), req.url);
  assert.deepEqual([...req.headers.keys()].sort(), ['x-dashboard-reader-secret', 'x-gate-session']);
  assert.notEqual(req.headers.get('x-gate-session'), `gat_${'1'.repeat(32)}`, 'the session id comes from the verified token, not the browser');
  // Every answer is private and never cached; no Set-Cookie passes.
  assert.equal(drafts.headers.get('cache-control'), 'private, no-store');
  assert.equal(drafts.headers.get('vary'), 'Cookie');
  assert.equal(drafts.headers.get('set-cookie'), null);
  // Unconfigured proxy forwards nothing.
  for (const cfg of [{ workerOrigin: undefined }, { workerOrigin: WORKER }, { workerOrigin: WORKER, readerSecret: rnd() },
                     { workerOrigin: WORKER, readerSecret: rnd(), sitePassword: 'x', signingKey: 'short' }]) {
    const off = createProxy({ ...cfg, fetchImpl: () => { throw new Error('must not be called'); } });
    assert.equal((await off(new Request(`${SITE}/api/v1/weeks`, { headers: { cookie: b.cookie } }))).status, 503, JSON.stringify(Object.keys(cfg)));
  }
});

test('the browser client only calls same-origin dashboard read routes with credentials', async () => {
  const calls = [];
  const fake = async (url, init) => { calls.push({ url, init }); return new Response('{"ok":true}', { status: 200 }); };
  await workerApi('/weeks', { fetchImpl: fake });
  assert.deepEqual([calls[0].url, calls[0].init.credentials], ['/api/v1/weeks', 'same-origin']);
  for (const p of ['/admin/settings', '/auth/login', '/gate/attempts', '/collect/budget', '/verify/pending', 'https://evil.example/x'])
    await assert.rejects(workerApi(p, { fetchImpl: fake }), /Only dashboard routes/, p);
});

test('C7: the dashboard reads the weekly automation status through the proxy; cycle admin routes stay unreachable', async () => {
  const { automationStatus } = await import('../../js/workerClient.js');
  const { renderAutomationStatus, automationStatusError } = await import('../../js/automationStatus.js');
  const { env } = await loaded(20, {}, { shippingReport: false });
  await worker.scheduled({ scheduledTime: Date.parse('2026-09-21T08:30:00Z') }, env, null);
  const b = await browser(env);
  await assert.rejects(automationStatus(WEEK, { fetchImpl: (p, i) => b.fetchImpl(p, { ...i, credentials: 'omit' }) }), e => e.status === 401 && e.code === 'signed_out');
  assert.match(automationStatusError({ status: 401, code: 'signed_out' }), /Reload the page to sign in again/);
  assert.match(automationStatusError({ status: 401 }), /access to the weekly automation status is not set up/);
  const s = await automationStatus(WEEK, { fetchImpl: b.fetchImpl });
  assert.equal(s.cycle.status, 'waiting_for_sources');
  const html = renderAutomationStatus(s);
  assert.match(html, /Waiting for sources/);
  assert.match(html, /ShipStation Shipping Cost Report \(missing\)/);
  assert.match(html, /Unverified \(provisional\)/);
  assert.match(html, /Publication<\/th><td[^>]*>Disabled/);
  assert.equal(renderAutomationStatus({ weekStart: '<img src=x onerror=alert(1)>' }).includes('<img'), false, 'values are escaped');
  assert.equal((await b.proxy(new Request(`${SITE}/api/v1/admin/cycles/${WEEK}`, { headers: { cookie: b.cookie } }))).status, 404);
  assert.equal((await b.proxy(new Request(`${SITE}/api/v1/automation/status`, { method: 'POST', headers: { cookie: b.cookie, origin: SITE } }))).status, 404, 'status is read-only');
});

test('A7 regression: the Worker login limit counts per client again, because only direct callers can reach it', async () => {
  const env = await makeEnv();
  const at = ip => (password) => call(env, 'POST', '/v1/auth/login', { body: { password }, headers: { 'CF-Connecting-IP': ip } });
  const a = at('203.0.113.7'), b = at('203.0.113.8');
  for (let i = 0; i < 10; i++) assert.equal((await a(`wrong-${i}`)).status, 401);
  assert.equal((await a(PASSWORD)).status, 429, 'locked client');
  assert.equal((await b(PASSWORD)).status, 200, 'another client signs in');
});

test('one sign-in: a valid gate session reads published weeks; anything else reaches nothing', async () => {
  const g = gateConfig();
  const { env } = await loaded(5, { DASHBOARD_READER_SECRET: rnd() });
  assert.equal((await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK })).status, 200);   // a draft exists; nothing is published
  const record = [];
  const proxy = createProxy({ workerOrigin: WORKER, readerSecret: env.DASHBOARD_READER_SECRET, ...g,
                              fetchImpl: async req => { record.push(req); return worker.fetch(req, env); } });
  const get = (p, headers = {}) => proxy(new Request(`${SITE}/api/v1${p}`, { headers }));
  const withGate = { cookie: await gateCookieHeader(g) };

  const r = await get('/weeks', withGate);
  assert.equal(r.status, 200);
  const viaSession = await call(env, 'GET', '/v1/weeks', { cookie: await sessionCookie(env) });
  assert.deepEqual(await r.json(), viaSession.json, 'same answer as a Worker session');
  assert.equal(record.at(-1).headers.get('x-dashboard-reader-secret'), env.DASHBOARD_READER_SECRET);
  assert.match(record.at(-1).headers.get('x-gate-session'), /^gat_[0-9a-f]{32}$/);
  const draft = await get(`/snapshot/${WEEK}?includeDrafts=1`, withGate);
  assert.deepEqual([draft.status, (await draft.json()).error], [404, 'not_published']);
  assert.equal((await get(`/weeks/${WEEK}/status`, withGate)).status, 200);
  const part = await get(`/snapshot/${WEEK}/report-part/0`, withGate);
  assert.deepEqual([part.status, (await part.json()).error], [404, 'not_published']);
  assert.equal((await get(`/snapshot/${WEEK}/report-part/x`, withGate)).status, 404);

  // Not signed in: no cookie, a forged one, the old sha256(password) cookie, an expired, wrong-epoch or foreign-key token,
  // or the reader secret sent by a browser. Nothing is forwarded at all.
  const before = record.length;
  const sha = nodeCrypto.createHash('sha256').update(g.sitePassword).digest('hex');
  const expired = (await gateToken(g, { now: Date.now() - 9 * 3600_000 })).token;
  const otherEpoch = (await gateToken({ ...g, epoch: '2' })).token;
  const otherKey = (await gateToken({ ...g, signingKey: nodeCrypto.randomBytes(32).toString('hex') })).token;
  const flip = (s, i) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
  const tampered = flip(withGate.cookie, withGate.cookie.lastIndexOf('.') + 5);   // a signature byte (the last character holds only padding bits)
  for (const headers of [{}, { cookie: '__gp_session=forged' }, { cookie: `__gp_session=${sha}` }, { cookie: `__gp_session=${expired}` },
                         { cookie: `__gp_session=${otherEpoch}` }, { cookie: `__gp_session=${otherKey}` }, { cookie: tampered },
                         { 'x-dashboard-reader-secret': env.DASHBOARD_READER_SECRET }]) {
    const res = await get('/weeks', headers);
    assert.deepEqual([res.status, (await res.json()).error], [401, 'signed_out'], JSON.stringify(headers).slice(0, 60));
  }
  assert.equal(record.length, before, 'no unauthenticated request reached the Worker');
  // Bumping the epoch signs everyone out.
  const bumped = createProxy({ workerOrigin: WORKER, readerSecret: env.DASHBOARD_READER_SECRET, ...g, epoch: '2', fetchImpl: req => worker.fetch(req, env) });
  assert.equal((await bumped(new Request(`${SITE}/api/v1/weeks`, { headers: withGate }))).status, 401);
});

test('the dashboard reader secret at the Worker: published reads only, a live gate session, one credential, configured and distinct', async () => {
  const { env } = await loaded(5, { DASHBOARD_READER_SECRET: rnd() });
  const jti = `gat_${nodeCrypto.randomBytes(16).toString('hex')}`;
  const R = { 'X-Dashboard-Reader-Secret': env.DASHBOARD_READER_SECRET, 'X-Gate-Session': jti };
  assert.equal((await call(env, 'GET', '/v1/weeks', { headers: R })).status, 200);
  assert.deepEqual([(await call(env, 'GET', '/v1/weeks', { headers: { 'X-Dashboard-Reader-Secret': env.DASHBOARD_READER_SECRET } })).json.error], ['gate_session_required']);
  assert.deepEqual([(await call(env, 'GET', '/v1/weeks', { headers: { ...R, 'X-Gate-Session': 'ses_x' } })).json.error], ['gate_session_required']);
  await env.DB.prepare('INSERT INTO session_revocation (jti, revoked_at, expires_at) VALUES (?1, ?2, ?3)').bind(jti, new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString()).run();
  assert.deepEqual([(await call(env, 'GET', '/v1/weeks', { headers: R })).json.error], ['session_revoked'], 'revoked at logout');
  const R2 = { ...R, 'X-Gate-Session': `gat_${nodeCrypto.randomBytes(16).toString('hex')}` };
  assert.deepEqual([(await call(env, 'GET', '/v1/weeks', { headers: { ...R2, 'X-Dashboard-Reader-Secret': rnd() } })).json.error], ['reader_auth']);
  assert.equal((await call(env, 'GET', '/v1/weeks', { headers: { ...R2, 'X-Admin-Secret': env.ADMIN_SECRET } })).status, 401, 'one credential at a time');
  for (const [m, p] of [['GET', '/v1/admin/settings'], ['POST', '/v1/admin/runs'], ['GET', '/v1/ingest/week-plan'], ['GET', '/v1/collect/budget'], ['POST', '/v1/gate/attempts']]) {
    assert.equal((await call(env, m, p, { headers: R2, body: m === 'POST' ? { weekStart: WEEK } : undefined })).status === 200, false, `${m} ${p}`);
  }
  const unset = { ...env }; delete unset.DASHBOARD_READER_SECRET;
  assert.deepEqual([(await call(unset, 'GET', '/v1/weeks', { headers: R2 })).json.error], ['reader_not_configured']);
  assert.equal((await call({ ...env, DASHBOARD_READER_SECRET: env.ADMIN_SECRET }, 'GET', '/v1/weeks', { headers: { ...R2, 'X-Dashboard-Reader-Secret': env.ADMIN_SECRET } })).status, 500);
  assert.equal((await call({ ...env, DASHBOARD_READER_SECRET: 'short' }, 'GET', '/v1/weeks', { headers: { ...R2, 'X-Dashboard-Reader-Secret': 'short' } })).status, 500);
});
