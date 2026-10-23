/**
 * Site-password gate, end to end in-process: the Netlify edge functions that Netlify deploys
 * (auth-login.js, auth.js, api-proxy.js) wired to the real Worker handler on a D1 stand-in.
 * Synthetic password, keys, addresses and sheet markers only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import worker from '../src/index.js';
import { createLogin } from '../../netlify/edge-functions/auth-login.js';
import { createGate, isSensitivePath } from '../../netlify/edge-functions/auth.js';
import { createProxy } from '../../netlify/edge-functions/api-proxy.js';
import { config as loginConfig } from '../../netlify/edge-functions/auth-login.js';
import { config as gateFnConfig } from '../../netlify/edge-functions/auth.js';
import { config as proxyConfig } from '../../netlify/edge-functions/api-proxy.js';
import { GATE_COOKIE, safeRedirect, verifyGateToken, signGateToken, clientKey } from '../../shared/gateSession.js';
import { makeEnv, call, rnd, PASSWORD } from './helpers.mjs';
import { gateConfig, gateToken } from '../../tests/gate-fixture.mjs';

const SITE = 'https://sb-profit.netlify.app';
const WORKER = 'https://sb-gp-worker.example.workers.dev';
const SHEET_MARK = `PRIVSHEET${nodeCrypto.randomUUID().replace(/-/g, '')}`;

/** One deployment: Netlify env, the three edge functions and the Worker. `workerDown` makes the Worker unreachable. */
async function site({ netlify = {}, workerEnv = {}, sheet } = {}) {
  const g = gateConfig();
  const wenv = await makeEnv({ GATE_SECRET: g.gateSecret, DASHBOARD_READER_SECRET: rnd(), ...workerEnv });
  const state = { workerDown: false, bodies: [] };
  const vars = { SITE_PASSWORD: g.sitePassword, GATE_SIGNING_KEY: g.signingKey, GATE_SESSION_EPOCH: g.epoch, SB_WORKER_ORIGIN: WORKER,
                 SB_WORKER_GATE_SECRET: g.gateSecret, SB_WORKER_READER_SECRET: wenv.DASHBOARD_READER_SECRET,
                 MCG_EXTRA_SHEET_URL: `https://docs.google.com/spreadsheets/d/${SHEET_MARK}/export?format=csv`, ...netlify };
  const env = k => vars[k];
  const fetchImpl = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    if (req.url.startsWith(WORKER)) { if (state.workerDown) throw new TypeError(`fetch failed: ${WORKER}`); return worker.fetch(req, wenv); }
    if (sheet) return sheet(req);
    throw new TypeError(`fetch failed: ${req.url}`);
  };
  const login = createLogin({ env, fetchImpl });
  const gate = createGate({ env, fetchImpl });
  const proxy = createProxy({ workerOrigin: env('SB_WORKER_ORIGIN'), readerSecret: env('SB_WORKER_READER_SECRET'), sitePassword: env('SITE_PASSWORD'),
                              signingKey: env('GATE_SIGNING_KEY'), epoch: env('GATE_SESSION_EPOCH'), fetchImpl });
  const keep = async res => { state.bodies.push(await res.clone().text()); return res; };
  const next = async () => new Response('STATIC-FILE', { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=0, must-revalidate' } });
  const signIn = (password, { ip = '198.51.100.20', redirect } = {}) => login(new Request(`${SITE}/__auth`, { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password, ...(redirect ? { redirect } : {}) }).toString() }), { ip }).then(keep);
  const get = (path, cookie) => {
    const req = new Request(`${SITE}${path}`, { headers: cookie ? { cookie } : {} });
    return (path.startsWith('/api/v1/') ? proxy(req) : gate(req, { ip: '198.51.100.20', next })).then(keep);
  };
  const cookieOf = res => (res.headers.get('set-cookie') || '').split(';')[0];
  return { g, wenv, vars, state, signIn, get, cookieOf, login, gate, proxy };
}

test('sign-in: a signed, expiring HttpOnly session; wrong passwords get no cookie; GET /__auth goes home', async () => {
  const s = await site();
  const ok = await s.signIn(s.g.sitePassword);
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/');
  assert.match(ok.headers.get('set-cookie'), new RegExp(`^${GATE_COOKIE}=g1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800$`));
  const p = await verifyGateToken(s.cookieOf(ok).split('=')[1], { signingKey: s.g.signingKey, epoch: '1' });
  assert.ok(p && p.exp - p.iat === 8 * 3600);
  assert.ok(!s.cookieOf(ok).includes(nodeCrypto.createHash('sha256').update(s.g.sitePassword).digest('hex')), 'never a function of the password');
  const page = await s.get('/', s.cookieOf(ok));
  assert.equal(await page.text(), 'STATIC-FILE');

  const bad = await s.signIn('wrong');
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get('set-cookie'), null);
  assert.match(await bad.text(), /Incorrect password/);
  assert.equal(bad.headers.get('cache-control'), 'private, no-store');
  const home = await s.login(new Request(`${SITE}/__auth`), { ip: '198.51.100.20' });
  assert.deepEqual([home.status, home.headers.get('location')], [303, '/']);
});

test('A3: exact lockout per client after 10 failures in 15 minutes, even with the right password; other clients unaffected; bursts counted', async () => {
  const s = await site();
  for (let i = 0; i < 10; i++) assert.equal((await s.signIn(`wrong-${i}`, { ip: '198.51.100.30' })).status, 401);
  const locked = await s.signIn(s.g.sitePassword, { ip: '198.51.100.30' });
  assert.equal(locked.status, 429);
  assert.equal(locked.headers.get('set-cookie'), null);
  assert.match(await locked.text(), /Too many attempts/);
  assert.equal((await s.signIn(s.g.sitePassword, { ip: '198.51.100.31' })).status, 303, 'another client still signs in: no site-wide ceiling');
  // A parallel burst cannot slip past the limit: every attempt is counted before any password is compared.
  const burst = await Promise.all(Array.from({ length: 15 }, (_, i) => s.signIn(`burst-${i}`, { ip: '198.51.100.32' })));
  assert.equal(burst.filter(r => r.status === 401).length, 10);
  assert.equal(burst.filter(r => r.status === 429).length, 5);
  assert.equal((await s.signIn(s.g.sitePassword, { ip: '198.51.100.32' })).status, 429);
  // Successful sign-ins do not count; the window expires.
  for (let i = 0; i < 12; i++) assert.equal((await s.signIn(s.g.sitePassword, { ip: '198.51.100.33' })).status, 303);
  await s.wenv.DB.prepare("UPDATE auth_attempt SET attempt_at = '2000-01-01T00:00:00.000Z'").run();
  assert.equal((await s.signIn(s.g.sitePassword, { ip: '198.51.100.30' })).status, 303, 'after the window');
  // The gate never sends an address: only keyed hashes are stored, and they never mix with the Worker login's counter.
  const rows = (await s.wenv.DB.prepare('SELECT DISTINCT ip_hash FROM auth_attempt').all()).results.map(r => r.ip_hash);
  assert.ok(rows.every(h => /^g:[A-Za-z0-9_-]{32}$/.test(h)), 'gate rows are prefixed hashes');
  assert.ok(!rows.join().includes('198.51.100'));
  assert.equal((await call(s.wenv, 'POST', '/v1/auth/login', { body: { password: PASSWORD } })).status, 200, 'Worker login unaffected');
});

test('A2: logout revokes the token on the server; a copied token reads no data file and no report', async () => {
  const s = await site();
  const cookie = s.cookieOf(await s.signIn(s.g.sitePassword));
  assert.equal(await (await s.get('/data/mcg_total.json', cookie)).text(), 'STATIC-FILE');
  assert.equal((await s.get('/api/v1/weeks', cookie)).status, 200);
  const out = await s.get('/__logout', cookie);
  assert.deepEqual([out.status, out.headers.get('location')], [303, '/']);
  assert.match(out.headers.get('set-cookie'), new RegExp(`^${GATE_COOKIE}=; .*Max-Age=0$`));
  // A copy taken before logout: data files and reports refused; public pages and scripts still load until expiry (disclosed).
  const data = await s.get('/data/mcg_total.json', cookie);
  assert.notEqual(await data.text(), 'STATIC-FILE');
  const api = await s.get('/api/v1/weeks', cookie);
  assert.deepEqual([api.status, (await api.json()).error], [401, 'session_revoked']);
  assert.equal(await (await s.get('/index.html', cookie)).text(), 'STATIC-FILE');
  // A fresh gate instance (another edge location, empty cache) refuses it too.
  const other = createGate({ env: k => s.vars[k], fetchImpl: (r, i) => worker.fetch(r instanceof Request ? r : new Request(r, i), s.wenv) });
  const again = await other(new Request(`${SITE}/data/mcg_total.json`, { headers: { cookie } }), { ip: '198.51.100.20', next: async () => new Response('STATIC-FILE') });
  assert.notEqual(await again.text(), 'STATIC-FILE');
});

test('logout when the Worker cannot be reached: signed out here, and the page says the session is still valid elsewhere', async () => {
  const s = await site();
  const cookie = s.cookieOf(await s.signIn(s.g.sitePassword));
  s.state.workerDown = true;
  const out = await s.get('/__logout', cookie);
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0$/);
  assert.match(await out.text(), /could not be recorded on the server/);
});

test('expiry, epoch bump, forged and old-format cookies: the sign-in page everywhere', async () => {
  const s = await site();
  const expired = (await gateToken(s.g, { now: Date.now() - 9 * 3600_000 })).token;
  const future = (await signGateToken({ signingKey: s.g.signingKey, epoch: '1', now: Date.now() + 3600_000 })).token;
  const sha = nodeCrypto.createHash('sha256').update(s.g.sitePassword).digest('hex');
  for (const v of [expired, future, sha, 'forged', (await gateToken({ ...s.g, epoch: '7' })).token]) {
    for (const path of ['/', '/data/mcg_total.json', '/api/mcg-extra']) {
      const r = await s.get(path, `${GATE_COOKIE}=${v}`);
      const text = await r.text();
      assert.ok(text.includes('<form method="POST" action="/__auth">') && !text.includes('STATIC-FILE'), `${path} ${v.slice(0, 8)}`);
    }
  }
  // Bumping GATE_SESSION_EPOCH signs every existing session out.
  const cookie = s.cookieOf(await s.signIn(s.g.sitePassword));
  s.vars.GATE_SESSION_EPOCH = '2';
  assert.ok((await (await s.get('/', cookie)).text()).includes('action="/__auth"'));
});

test('missing or unsafe configuration answers 503 and opens nothing; an unreachable Worker fails closed', async () => {
  for (const netlify of [{ SITE_PASSWORD: undefined }, { GATE_SIGNING_KEY: undefined }, { GATE_SIGNING_KEY: 'short-key' },
                         { SB_WORKER_ORIGIN: undefined }, { SB_WORKER_ORIGIN: 'http://insecure.example' }, { SB_WORKER_GATE_SECRET: undefined }, { SB_WORKER_GATE_SECRET: 'short' }]) {
    const s = await site({ netlify });
    const r = await s.signIn(s.g.sitePassword);
    assert.equal(r.status, 503, JSON.stringify(netlify));
    assert.equal(r.headers.get('set-cookie'), null);
  }
  const same = await site();
  same.vars.GATE_SIGNING_KEY = same.vars.SITE_PASSWORD = 'x'.repeat(40);
  assert.equal((await same.signIn('x'.repeat(40))).status, 503, 'signing key must not be the password');
  for (const netlify of [{ SITE_PASSWORD: undefined }, { GATE_SIGNING_KEY: undefined }]) {
    const s = await site({ netlify });
    assert.equal((await s.get('/', 'x=y')).status, 503);
  }
  const s = await site();
  const cookie = s.cookieOf(await s.signIn(s.g.sitePassword));
  s.state.workerDown = true;
  assert.equal((await s.signIn(s.g.sitePassword, { ip: '198.51.100.40' })).status, 503, 'sign-in needs the attempt counter');
  assert.equal((await s.get('/data/fresh-file.json', cookie)).status, 503, 'data files need the revocation check');
  // The Worker refuses the gate routes without its own secret configured, and the gate credential reads no report.
  const w = await makeEnv({ DASHBOARD_READER_SECRET: rnd() });
  const H = { 'X-Gate-Secret': 'g'.repeat(40) };
  assert.deepEqual([(await call(w, 'POST', '/v1/gate/attempts', { headers: H, body: { ipHash: 'a'.repeat(32) } })).json.error], ['gate_not_configured']);
  assert.equal((await call({ ...w, GATE_SECRET: w.ADMIN_SECRET }, 'POST', '/v1/gate/attempts', { headers: { 'X-Gate-Secret': w.ADMIN_SECRET }, body: { ipHash: 'a'.repeat(32) } })).status, 500);
  const w2 = { ...w, GATE_SECRET: 'g'.repeat(40) };
  for (const [m, p] of [['GET', '/v1/weeks'], ['GET', '/v1/admin/settings'], ['GET', '/v1/collect/budget'], ['GET', '/v1/verify/pending']])
    assert.ok([401, 503].includes((await call(w2, m, p, { headers: H })).status), `${m} ${p}`);
  assert.equal((await call(w2, 'POST', '/v1/gate/attempts', { headers: { 'X-Gate-Secret': 'h'.repeat(40) }, body: { ipHash: 'a'.repeat(32) } })).json.error, 'gate_auth');
  for (const body of [{}, { ipHash: '1.2.3.4' }, { ipHash: 'x' }])
    assert.equal((await call(w2, 'POST', '/v1/gate/attempts', { headers: H, body })).status, 400);
  for (const body of [{ jti: 'ses_1', exp: 1 }, { jti: `gat_${'0'.repeat(32)}`, exp: Math.floor(Date.now() / 1000) + 30 * 86400 }, { jti: `gat_${'0'.repeat(32)}` }])
    assert.equal((await call(w2, 'POST', '/v1/gate/revocations', { headers: H, body })).status, 400);
});

test('A4: after sign-in only same-site paths are followed', () => {
  for (const [r, want] of [['/reports?x=1', '/reports?x=1'], ['//evil.example/x', '/'], ['/\\evil.example', '/'], ['https://evil.example', '/'],
                           ['/%2F%2Fevil.example', '/%2F%2Fevil.example'], ['javascript:alert(1)', '/'], ['/a\nb', '/'], ['', '/'], [null, '/'], ['/'.padEnd(600, 'a'), '/']])
    assert.equal(safeRedirect(r), want, String(r));
});

test('A6: /api/mcg-extra failures carry no sheet address, column name or exception text; success stays private', async () => {
  const failing = [
    () => { throw new TypeError(`fetch failed: https://docs.google.com/spreadsheets/d/${SHEET_MARK}`); },
    () => new Response('nope', { status: 404, statusText: `Not Found ${SHEET_MARK}` }),
    () => new Response(`Secret Column ${SHEET_MARK},Other\nA,1`),
  ];
  for (const sheet of failing) {
    const s = await site({ sheet });
    const cookie = s.cookieOf(await s.signIn(s.g.sitePassword));
    const r = await s.get('/api/mcg-extra', cookie);
    const text = await r.text();
    assert.equal(r.status, 502);
    assert.deepEqual(JSON.parse(text), { error: 'mcg_extra_unavailable' });
    assert.ok(!text.includes(SHEET_MARK) && !text.includes('Secret Column'));
  }
  const s = await site({ sheet: () => new Response('SKU,Cost Per Item,Description\nZZ-1,2.5,ZZ01 Test plant / 2in\n') });
  const cookie = s.cookieOf(await s.signIn(s.g.sitePassword));
  const r = await s.get('/api/mcg-extra', cookie);
  assert.deepEqual(await r.json(), { 'ZZ-1': 2.5, '__n__test plant': 2.5 });
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
});

test('A9: data files are private and never cached; responses never echo a secret, the password or an address', async () => {
  const s = await site();
  const cookie = s.cookieOf(await s.signIn(s.g.sitePassword));
  const r = await s.get('/data/mcg_total.json', cookie);
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
  assert.equal(r.headers.get('vary'), 'Cookie');
  s.state.workerDown = true;
  await s.signIn(s.g.sitePassword);
  await s.get('/data/other.json', cookie);
  await s.signIn('wrong');
  const all = s.state.bodies.join('\n');
  for (const secret of [s.g.sitePassword, s.g.signingKey, s.g.gateSecret, s.wenv.DASHBOARD_READER_SECRET, '198.51.100', WORKER, SHEET_MARK])
    assert.ok(!all.includes(secret), 'a response leaked a private value');
});

test('A8/A10: every edge function is declared inline with non-overlapping paths and its native rate limit', async () => {
  assert.deepEqual([loginConfig.path, loginConfig.rateLimit], ['/__auth', { windowLimit: 10, windowSize: 60, aggregateBy: ['ip', 'domain'] }]);
  assert.equal(gateFnConfig.path, '/*');
  for (const p of ['/__auth', '/api/v1/*', '/.netlify/functions/gp-verify', '/.netlify/functions/gp-verify-background']) assert.ok(gateFnConfig.excludedPath.includes(p), p);
  assert.deepEqual(gateFnConfig.rateLimit, { windowLimit: 1200, windowSize: 60, aggregateBy: ['ip', 'domain'] });
  assert.deepEqual([proxyConfig.path, proxyConfig.rateLimit], ['/api/v1/*', { windowLimit: 3000, windowSize: 60, aggregateBy: ['ip', 'domain'] }]);
  for (const c of [loginConfig, gateFnConfig, proxyConfig]) assert.ok(c.rateLimit.windowSize <= 180, 'Netlify maximum window');
  const fs = await import('node:fs');
  const toml = fs.readFileSync(new URL('../../netlify.toml', import.meta.url), 'utf8');
  assert.ok(!/^\s*\[\[edge_functions\]\]/m.test(toml), 'no netlify.toml declaration: it would run before the inline ones');
});

test('review fix: encoded, case-changed and trailing-slash forms of the data paths still get the revocation check', async () => {
  for (const p of ['/data/x.json', '/data/x.js%6Fn', '/data/x%2Ejson', '/DATA/x.json', '/Data/X.JSON', '/data/x.json/', '/%64ata/x.json', '/%2564ata/x.json',
                   '/data//x.json', '/api/mcg-extra', '/api/MCG-EXTRA', '/%zz'])
    assert.equal(isSensitivePath(p), true, p);
  for (const p of ['/', '/index.html', '/js/app.js', '/datafile.json', '/css/data.css']) assert.equal(isSensitivePath(p), false, p);
  const s = await site();
  const cookie = s.cookieOf(await s.signIn(s.g.sitePassword));
  await s.get('/__logout', cookie);
  for (const p of ['/data/mcg_total.js%6Fn', '/DATA/mcg_total.json', '/data/mcg_total.json/', '/%64ata/mcg_total.json']) {
    const r = await s.get(p, cookie);
    assert.notEqual(await r.text(), 'STATIC-FILE', p);
  }
});

test('review fix: IPv6 clients are counted by their /64, so rotating addresses inside one prefix gets no fresh budget', async () => {
  assert.equal(clientKey('2001:db8:1:2:aaaa::1'), clientKey('2001:DB8:1:2:ffff:ffff:ffff:ffff'));
  assert.notEqual(clientKey('2001:db8:1:2::1'), clientKey('2001:db8:1:3::1'));
  assert.equal(clientKey('::ffff:203.0.113.5'), '203.0.113.5');
  assert.equal(clientKey('[2001:db8::1]'), clientKey('2001:0db8:0000:0000::2'));
  const s = await site();
  for (let i = 0; i < 10; i++) assert.equal((await s.signIn(`wrong-${i}`, { ip: `2001:db8:5:6::${(i + 1).toString(16)}` })).status, 401);
  assert.equal((await s.signIn(s.g.sitePassword, { ip: '2001:db8:5:6:abcd:ef01:2345:6789' })).status, 429, 'same /64');
  assert.equal((await s.signIn(s.g.sitePassword, { ip: '2001:db8:5:7::1' })).status, 303, 'another /64');
});

test('review fix: a "not revoked" answer is reused for at most 10 seconds on another edge instance', async () => {
  const s = await site();
  const cookie = s.cookieOf(await s.signIn(s.g.sitePassword));
  let t = Date.now();
  const other = createGate({ env: k => s.vars[k], now: () => t, fetchImpl: (r, i) => worker.fetch(r instanceof Request ? r : new Request(r, i), s.wenv) });
  const read = async () => (await (await other(new Request(`${SITE}/data/mcg_total.json`, { headers: { cookie } }), { ip: '198.51.100.20', next: async () => new Response('STATIC-FILE') })).text()) === 'STATIC-FILE';
  assert.equal(await read(), true);                 // cached "not revoked" on this instance
  await s.get('/__logout', cookie);                 // revoked through another instance
  t += 9_000; assert.equal(await read(), true, 'within the 10-second reuse window (documented)');
  t += 2_000; assert.equal(await read(), false, 'refused after it');
});
