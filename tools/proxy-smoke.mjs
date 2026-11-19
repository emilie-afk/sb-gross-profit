#!/usr/bin/env node
/**
 * Smoke test of the REAL Netlify gate and proxy path, to run against a deploy preview or staging site:
 *
 *   SITE_PASSWORD=… node tools/proxy-smoke.mjs https://deploy-preview-12--sb-profit.netlify.app
 *
 * The password comes from the environment only (never arguments, never logged).
 * Checks: signed-out reads refused → wrong password gives no cookie → sign-in sets a signed HttpOnly,
 * Secure, SameSite=Strict session and follows only same-site redirects → published read through
 * /api/v1, private and uncached → admin, ingest, gate and Worker sign-in routes not reachable →
 * logout clears the cookie and revokes it on the server: a copy reads no report and no data file → encoded
 * paths that decode to a data file (%2f, %5c, double-encoded) answer 400, before and after logout.
 * It does not exercise the failed-password lockout (that would lock this machine out for 15 minutes);
 * worker/test/gate.test.mjs covers it in-process. Exit 0 = all passed.
 */
const site = (process.argv[2] || '').replace(/\/+$/, '');
const { SITE_PASSWORD } = process.env;
// https only, except a local dry run on 127.0.0.1 (tests/gate-smoke.test.mjs).
if (!(/^https:\/\//.test(site) || /^http:\/\/127\.0\.0\.1:\d+$/.test(site)) || !SITE_PASSWORD) {
  console.error('usage: SITE_PASSWORD=… node tools/proxy-smoke.mjs https://<site>');
  process.exit(10);
}
const GATE = '__gp_session';
async function req(path, { method = 'GET', cookie, form } = {}) {
  const headers = {};
  if (cookie) headers.cookie = `${GATE}=${cookie}`;
  if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; headers.origin = site; }
  return fetch(site + path, { method, headers, redirect: 'manual', body: form ? new URLSearchParams(form) : undefined });
}
const tokenOf = res => { const c = res.headers.getSetCookie().find(s => s.startsWith(`${GATE}=`)); return c ? c.split(';')[0].slice(GATE.length + 1) : null; };
const isLoginPage = async res => (await res.text()).includes('action="/__auth"');
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`); };

check('signed out: reports refused', (await req('/api/v1/weeks')).status === 401);
check('signed out: data files show the sign-in page', await isLoginPage(await req('/data/vendor_import_report.json')));
const bad = await req('/__auth', { method: 'POST', form: { password: `wrong-${Date.now()}` } });
check('wrong password: 401 and no cookie', bad.status === 401 && !tokenOf(bad), `status ${bad.status}`);
const ok = await req('/__auth', { method: 'POST', form: { password: SITE_PASSWORD, redirect: '//evil.example/' } });
const flags = ok.headers.getSetCookie().find(s => s.startsWith(`${GATE}=`)) || '';
const token = tokenOf(ok);
check('sign-in sets a signed session', ok.status === 303 && /^g1\.[\w-]+\.[\w-]+$/.test(token || ''), `status ${ok.status}`);
check('cookie is HttpOnly; Secure; SameSite=Strict; Path=/; 8 hours', ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=28800'].every(f => flags.includes(f)));
check('redirect stays on this site', ok.headers.get('location') === '/', ok.headers.get('location') || '');
const weeks = await req('/api/v1/weeks', { cookie: token });
check('published weeks read', weeks.status === 200, `status ${weeks.status}`);
check('report reads are private and uncached', weeks.headers.get('cache-control') === 'private, no-store' && /cookie/i.test(weeks.headers.get('vary') || ''));
for (const p of ['/api/v1/admin/settings', '/api/v1/ingest/week-plan', '/api/v1/gate/attempts', '/api/v1/auth/session'])
  check(`${p} not reachable`, (await req(p, { cookie: token })).status === 404);
// Encoded paths that resolve to a data file once decoded: refused with 400 by the gate, for a live session too, so no
// handler (or Netlify's static server) ever sees them.
const ENCODED = ['/x%2f..%2fdata/vendor_import_report.json', '/x%2F..%2Fdata/vendor_import_report.json', '/x%252f..%252fdata/vendor_import_report.json',
                 '/x%5c..%5cdata/vendor_import_report.json', '/data%2fvendor_import_report.json'];
for (const p of ENCODED) {
  const r = await req(p, { cookie: token });
  check(`encoded path refused: ${p}`, r.status === 400 && !(await r.text()).includes('"generatedAt"'), `status ${r.status}`);
}
const out = await req('/__logout', { cookie: token });
check('logout clears the cookie', out.status === 303 && out.headers.getSetCookie().some(s => s.startsWith(`${GATE}=;`) && /Max-Age=0/.test(s)), `status ${out.status}`);
const revoked = await req('/api/v1/weeks', { cookie: token });
check('a copied cookie is revoked for reports', revoked.status === 401 && (await revoked.json()).error === 'session_revoked', `status ${revoked.status}`);
check('a copied cookie is revoked for data files', await isLoginPage(await req('/data/vendor_import_report.json', { cookie: token })));
check('a forged cookie is refused', (await req('/api/v1/weeks', { cookie: 'g1.forged.token' })).status === 401);
// Dot segments the URL parser resolves itself arrive as the plain data path: the revoked copy is refused there too.
check('a copied cookie is revoked for /x/%2e%2e/data/…', await isLoginPage(await req('/x/%2e%2e/data/vendor_import_report.json', { cookie: token })));
for (const p of ENCODED) check(`encoded path refused after logout: ${p}`, (await req(p, { cookie: token })).status === 400);

const failed = checks.filter(c => !c.ok).length;
console.log(failed ? `\n${failed} check(s) failed` : '\nAll gate and proxy checks passed');
process.exit(failed ? 1 : 0);
