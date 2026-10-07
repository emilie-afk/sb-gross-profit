/**
 * Netlify Edge Function — same-origin proxy to the SB GP Worker
 * =============================================================
 *   browser  →  https://<dashboard>/api/v1/<route>  →  <SB_WORKER_ORIGIN>/v1/<route>
 *
 * Why: the Worker's session cookie is SameSite=Strict, HttpOnly, Secure. It is
 * only sent when the browser's request is same-origin, so the dashboard calls
 * its OWN origin and this function forwards to the Worker.
 *
 * What it forwards, and nothing else:
 *   - dashboard routes only: auth (login, logout, session), published reads and the
 *     weekly automation status (codes and timestamps only).
 *     /v1/ingest/* and /v1/admin/* are not reachable through the browser path.
 *   - headers: Content-Type, Accept, Origin, and the `sb_session` cookie. The
 *     site-password cookie, any X-*-Secret header and client IP headers are dropped.
 *   - POST requests must carry this site's own Origin (CSRF defence in depth).
 *
 * One sign-in: the site password. For the dashboard's published reads (GET, not auth routes) the
 * proxy attaches the Worker's dashboard reader secret, but only after checking the site-password
 * cookie itself (the same cookie the password gate sets), so a misordered or missing gate can never
 * open the reports. The reader sees published weeks only, exactly like a session; drafts, ingest and
 * admin routes stay unreachable. Without SB_WORKER_READER_SECRET or SITE_PASSWORD nothing is attached
 * and the Worker refuses the read (401).
 *
 * Configuration (Netlify environment variables): SB_WORKER_ORIGIN (e.g.
 * https://sb-gp-worker.<account>.workers.dev; unset → 503, nothing is forwarded),
 * SB_WORKER_READER_SECRET (= the Worker's DASHBOARD_READER_SECRET) and SITE_PASSWORD (the gate's).
 * Declared in netlify.toml AFTER the password gate, so the site password is
 * still required first.
 */

const ROUTES = [
  ['POST', /^\/v1\/auth\/(login|logout)$/],
  ['GET',  /^\/v1\/auth\/session$/],
  ['GET',  /^\/v1\/(weeks|history|compare)$/],
  ['GET',  /^\/v1\/automation\/status$/],
  ['GET',  /^\/v1\/weeks\/\d{4}-\d{2}-\d{2}\/status$/],
  ['GET',  /^\/v1\/snapshot\/\d{4}-\d{2}-\d{2}(\/(orders(\/[^/]+)?|issues|scenario-input))?$/],
];
const FORWARD = ['content-type', 'accept', 'origin'];
const RETURN = ['content-type', 'cache-control', 'x-content-type-options', 'referrer-policy'];
const SESSION_COOKIE = 'sb_session';
const SITE_COOKIE = '__gp_session';                       // set by the password gate (auth.js): sha256(SITE_PASSWORD)
const READER_HEADER = 'x-dashboard-reader-secret';
const AUTH_ROUTE = /^\/v1\/auth\//;

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
const cookieOf = (request, name) => (request.headers.get('cookie') || '').split(';').map(c => c.trim()).find(c => c.startsWith(`${name}=`)) || null;
/** Constant-time string comparison. */
function sameString(a, b) {
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}
/** The request carries the password gate's cookie for the current site password. */
async function passedSiteGate(request, sitePassword) {
  const c = cookieOf(request, SITE_COOKIE);
  return !!(sitePassword && c) && sameString(c.slice(SITE_COOKIE.length + 1), await sha256Hex(sitePassword));
}

const reply = (status, error, message) => new Response(JSON.stringify({ error, message }), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

export function createProxy({ workerOrigin, readerSecret, sitePassword, fetchImpl = fetch }) {
  return async function proxy(request) {
    if (!workerOrigin || !/^https:\/\/[^/]+$/.test(workerOrigin)) return reply(503, 'proxy_not_configured', 'SB_WORKER_ORIGIN is not set');
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api(?=\/v1\/)/, '').replace(/\/+$/, '');
    if (!ROUTES.some(([m, re]) => m === request.method && re.test(path))) return reply(404, 'not_found', 'No such route');
    if (request.method !== 'GET' && request.headers.get('origin') !== url.origin) return reply(403, 'cross_origin', 'Cross-origin request refused');

    const headers = new Headers();
    for (const h of FORWARD) if (request.headers.has(h)) headers.set(h, request.headers.get(h));
    const session = cookieOf(request, SESSION_COOKIE);
    if (session) headers.set('cookie', session);
    if (request.method === 'GET' && !AUTH_ROUTE.test(path) && readerSecret && await passedSiteGate(request, sitePassword)) headers.set(READER_HEADER, readerSecret);

    const upstream = await fetchImpl(new Request(`${workerOrigin}${path}${url.search}`, {
      method: request.method, headers, redirect: 'manual',
      body: request.method === 'GET' ? undefined : await request.text(),
    }));
    const out = new Headers();
    for (const h of RETURN) if (upstream.headers.has(h)) out.set(h, upstream.headers.get(h));
    const cookies = typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie()
      : (upstream.headers.get('set-cookie') ? [upstream.headers.get('set-cookie')] : []);
    for (const c of cookies) out.append('set-cookie', c);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  };
}

const env = name => globalThis.Netlify?.env?.get?.(name) ?? globalThis.Deno?.env?.get?.(name);

export default async request => createProxy({ workerOrigin: env('SB_WORKER_ORIGIN'), readerSecret: env('SB_WORKER_READER_SECRET'), sitePassword: env('SITE_PASSWORD') })(request);
