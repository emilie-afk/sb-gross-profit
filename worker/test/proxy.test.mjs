/**
 * Dashboard → Netlify edge proxy (/api/v1) → Worker, end to end in-process.
 * The proxy module is the file Netlify deploys; the upstream is the real
 * Worker handler on a D1 stand-in. A deploy-preview run against the real
 * Netlify edge is tools/proxy-smoke.mjs (not run here: nothing is deployed).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { signSession } from '../src/auth.js';
import { createProxy } from '../../netlify/edge-functions/api-proxy.js';
import { workerApi, login, logout, session } from '../../js/workerClient.js';
import { PASSWORD, WEEK, makeEnv, loaded, admin } from './helpers.mjs';

const SITE = 'https://sb-profit.netlify.app';
const WORKER = 'https://sb-gp-worker.example.workers.dev';

/** A browser stand-in: same-origin fetch with a cookie jar, through the proxy. */
function browser(env, { record } = {}) {
  const jar = new Map([['__gp_session', 'site-password-cookie']]);        // the password gate's cookie
  const proxy = createProxy({ workerOrigin: WORKER, fetchImpl: async req => { record?.push(req); return worker.fetch(req, env); } });
  const fetchImpl = async (path, init = {}) => {
    const headers = new Headers(init.headers || {});
    if (init.credentials !== 'omit') headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
    if ((init.method || 'GET') !== 'GET') headers.set('origin', SITE);    // browsers send Origin on same-origin POST
    const res = await proxy(new Request(`${SITE}${path}`, { ...init, headers }));
    for (const c of res.headers.getSetCookie()) {
      const [kv, ...attrs] = c.split(';'); const [k, v] = kv.split('=');
      if (/max-age=0/i.test(attrs.join(';'))) jar.delete(k.trim()); else jar.set(k.trim(), v);
    }
    return res;
  };
  return { fetchImpl, jar, proxy };
}

test('login, session check and logout work through the same-origin proxy with a Strict session cookie', async () => {
  const env = await makeEnv();
  const b = browser(env);
  await assert.rejects(session({ fetchImpl: b.fetchImpl }), e => e.status === 401 && e.code === 'session_expired');
  await assert.rejects(login('wrong', { fetchImpl: b.fetchImpl }), e => e.status === 401);

  const res = await b.proxy(new Request(`${SITE}/api/v1/auth/login`, { method: 'POST', headers: { origin: SITE, 'content-type': 'application/json' },
                                                                     body: JSON.stringify({ password: PASSWORD }) }));
  const setCookie = res.headers.getSetCookie()[0];
  assert.match(setCookie, /^sb_session=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200$/);

  await login(PASSWORD, { fetchImpl: b.fetchImpl });
  assert.ok(b.jar.has('sb_session'));
  const s = await session({ fetchImpl: b.fetchImpl });
  assert.equal(s.ok, true);
  assert.deepEqual((await workerApi('/weeks', { fetchImpl: b.fetchImpl })).weeks, []);

  const stolen = b.jar.get('sb_session');
  await logout({ fetchImpl: b.fetchImpl });
  assert.ok(!b.jar.has('sb_session'));
  await assert.rejects(session({ fetchImpl: b.fetchImpl }), e => e.status === 401);
  b.jar.set('sb_session', stolen);                                         // a copied cookie is revoked server-side
  await assert.rejects(session({ fetchImpl: b.fetchImpl }), e => e.status === 401);
});

test('an expired session is refused through the proxy', async () => {
  const env = await makeEnv();
  const b = browser(env);
  const { token } = await signSession(env, { now: Date.now() - 13 * 3600_000 });   // issued 13 h ago, 12 h lifetime
  b.jar.set('sb_session', token);
  await assert.rejects(session({ fetchImpl: b.fetchImpl }), e => e.status === 401 && e.code === 'session_expired');
});

test('the proxy exposes dashboard routes only and forwards no secrets, site cookie or foreign origin', async () => {
  const { env } = await loaded(5);
  const r = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  assert.equal(r.status, 200);
  const record = [];
  const b = browser(env, { record });
  for (const [m, p] of [['GET', '/api/v1/admin/settings'], ['POST', '/api/v1/admin/publish'], ['POST', '/api/v1/ingest/shopify'],
                        ['GET', '/api/v1/ingest/week-plan'], ['GET', '/api/v1/health/../admin/storage']]) {
    const res = await b.proxy(new Request(`${SITE}${p}`, { method: m, headers: { origin: SITE, 'x-admin-secret': env.ADMIN_SECRET, 'x-ingest-secret': env.INGEST_SECRET } }));
    assert.equal(res.status, 404, `${m} ${p}`);
  }
  // An admin secret sent by a browser is stripped: drafts stay invisible without a session.
  const drafts = await b.proxy(new Request(`${SITE}/api/v1/snapshot/${WEEK}?includeDrafts=1`, { headers: { 'x-admin-secret': env.ADMIN_SECRET } }));
  assert.equal(drafts.status, 401);
  // Cross-origin POST refused before reaching the Worker.
  const evil = await b.proxy(new Request(`${SITE}/api/v1/auth/login`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' }));
  assert.equal(evil.status, 403);
  await login(PASSWORD, { fetchImpl: b.fetchImpl });
  await session({ fetchImpl: b.fetchImpl });
  for (const req of record) {
    assert.ok(req.url.startsWith(`${WORKER}/v1/`), req.url);
    assert.ok(!req.headers.has('x-admin-secret') && !req.headers.has('x-ingest-secret'));
    assert.ok(!(req.headers.get('cookie') || '').includes('__gp_session'));
  }
  assert.equal(record.length, 3);                                           // only drafts-read, login, session reached the Worker
  // Unconfigured proxy forwards nothing.
  const off = createProxy({ workerOrigin: undefined });
  assert.equal((await off(new Request(`${SITE}/api/v1/auth/session`))).status, 503);
});

test('the browser client only calls same-origin dashboard routes with credentials', async () => {
  const calls = [];
  const fake = async (url, init) => { calls.push({ url, init }); return new Response('{"ok":true}', { status: 200 }); };
  await workerApi('/weeks', { fetchImpl: fake });
  assert.deepEqual([calls[0].url, calls[0].init.credentials], ['/api/v1/weeks', 'same-origin']);
  await assert.rejects(workerApi('/admin/settings', { fetchImpl: fake }), /Only dashboard routes/);
  await assert.rejects(workerApi('https://evil.example/x', { fetchImpl: fake }), /Only dashboard routes/);
});
