#!/usr/bin/env node
/**
 * Smoke test of the REAL Netlify proxy path, to run against a deploy preview
 * before dashboard integration (Revision 6, item 9):
 *
 *   SITE_PASSWORD=… DASHBOARD_PASSWORD=… node tools/proxy-smoke.mjs https://deploy-preview-12--sb-profit.netlify.app
 *
 * Passwords come from the environment only (never arguments, never logged).
 * Checks: site gate → Worker login through /api/v1 → cookie flags → session →
 * published read → admin/ingest not reachable → logout → revoked cookie refused
 * → cross-origin POST refused → (optional) expired session refused. Exit 0 = all passed.
 *
 *   … node tools/proxy-smoke.mjs https://<site> --expired-wait 90   (staging Worker with SESSION_TTL_SECONDS=60)
 */
const site = (process.argv[2] || '').replace(/\/+$/, '');
const { SITE_PASSWORD, DASHBOARD_PASSWORD } = process.env;
if (!/^https:\/\//.test(site) || !SITE_PASSWORD || !DASHBOARD_PASSWORD) {
  console.error('usage: SITE_PASSWORD=… DASHBOARD_PASSWORD=… node tools/proxy-smoke.mjs https://<site>');
  process.exit(10);
}
const jar = new Map();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
async function req(path, { method = 'GET', body, headers = {}, form } = {}) {
  const h = { cookie: cookieHeader(), ...headers };
  if (method !== 'GET' && !h.origin) h.origin = site;
  if (body !== undefined) h['content-type'] = 'application/json';
  if (form) h['content-type'] = 'application/x-www-form-urlencoded';
  const res = await fetch(site + path, { method, headers: h, redirect: 'manual',
    body: form ? new URLSearchParams(form) : body === undefined ? undefined : JSON.stringify(body) });
  for (const c of res.headers.getSetCookie()) {
    const [kv, ...attrs] = c.split(';'); const i = kv.indexOf('=');
    const k = kv.slice(0, i).trim(), v = kv.slice(i + 1);
    if (/max-age=0/i.test(attrs.join(';')) || v === '') jar.delete(k); else jar.set(k, v);
    if (k === 'sb_session' && v) res.sessionCookie = c;
  }
  return res;
}
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`); };

await req('/__auth', { method: 'POST', form: { password: SITE_PASSWORD } });
check('site password gate issued its cookie', jar.has('__gp_session'));
check('no session before login', (await req('/api/v1/auth/session')).status === 401);
const li = await req('/api/v1/auth/login', { method: 'POST', body: { password: DASHBOARD_PASSWORD } });
check('login through /api/v1', li.status === 200, `status ${li.status}`);
check('cookie is HttpOnly; Secure; SameSite=Strict; Path=/', /HttpOnly/.test(li.sessionCookie || '') && /Secure/.test(li.sessionCookie || '')
      && /SameSite=Strict/.test(li.sessionCookie || '') && /Path=\//.test(li.sessionCookie || ''), li.sessionCookie ? 'flags differ' : 'no cookie');
check('session check', (await req('/api/v1/auth/session')).status === 200);
check('published weeks read', (await req('/api/v1/weeks')).status === 200);
check('admin routes not reachable', (await req('/api/v1/admin/settings')).status === 404);
check('ingest routes not reachable', (await req('/api/v1/ingest/week-plan')).status === 404);
check('cross-origin POST refused', (await req('/api/v1/auth/logout', { method: 'POST', body: {}, headers: { origin: 'https://evil.example' } })).status === 403);
const copied = jar.get('sb_session');
check('logout', (await req('/api/v1/auth/logout', { method: 'POST', body: {} })).status === 200 && !jar.has('sb_session'));
jar.set('sb_session', copied);
check('revoked cookie refused after logout', (await req('/api/v1/auth/session')).status === 401);
jar.set('sb_session', 'forged.token');
check('forged cookie refused', (await req('/api/v1/auth/session')).status === 401);

// Expired session: only when the staging Worker runs with a short SESSION_TTL_SECONDS.
const waitIdx = process.argv.indexOf('--expired-wait');
if (waitIdx > 0) {
  const secs = parseInt(process.argv[waitIdx + 1], 10);
  jar.delete('sb_session');
  await req('/api/v1/auth/login', { method: 'POST', body: { password: DASHBOARD_PASSWORD } });
  check('fresh session before expiry', (await req('/api/v1/auth/session')).status === 200);
  console.log(`waiting ${secs}s for the session to expire…`);
  await new Promise(r => setTimeout(r, secs * 1000));
  const cookieAfter = jar.get('sb_session');
  const res = await fetch(site + '/api/v1/auth/session', { headers: { cookie: `__gp_session=${jar.get('__gp_session')}; sb_session=${cookieAfter}` } });
  check('expired session refused', res.status === 401, `status ${res.status}`);
} else console.log('SKIP  expired-session check (run with --expired-wait <seconds> against a Worker with a short SESSION_TTL_SECONDS)');

const failed = checks.filter(c => !c.ok).length;
console.log(failed ? `\n${failed} check(s) failed` : '\nAll proxy checks passed');
process.exit(failed ? 1 : 0);
