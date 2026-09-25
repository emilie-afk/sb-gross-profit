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
 * Configuration: SB_WORKER_ORIGIN (e.g. https://sb-gp-worker.<account>.workers.dev)
 * in Netlify environment variables. Unset → 503, nothing is forwarded.
 * Declared in netlify.toml AFTER the password gate, so the site password is
 * still required first.
 */

const ROUTES = [
  ['POST', /^\/v1\/auth\/(login|logout)$/],
  ['GET',  /^\/v1\/auth\/session$/],
  ['GET',  /^\/v1\/(weeks|history|compare)$/],
  ['GET',  /^\/v1\/automation\/status$/],
  ['GET',  /^\/v1\/snapshot\/\d{4}-\d{2}-\d{2}(\/(orders(\/[^/]+)?|issues|scenario-input))?$/],
];
const FORWARD = ['content-type', 'accept', 'origin'];
const RETURN = ['content-type', 'cache-control', 'x-content-type-options', 'referrer-policy'];
const SESSION_COOKIE = 'sb_session';

const reply = (status, error, message) => new Response(JSON.stringify({ error, message }), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

export function createProxy({ workerOrigin, fetchImpl = fetch }) {
  return async function proxy(request) {
    if (!workerOrigin || !/^https:\/\/[^/]+$/.test(workerOrigin)) return reply(503, 'proxy_not_configured', 'SB_WORKER_ORIGIN is not set');
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api(?=\/v1\/)/, '').replace(/\/+$/, '');
    if (!ROUTES.some(([m, re]) => m === request.method && re.test(path))) return reply(404, 'not_found', 'No such route');
    if (request.method !== 'GET' && request.headers.get('origin') !== url.origin) return reply(403, 'cross_origin', 'Cross-origin request refused');

    const headers = new Headers();
    for (const h of FORWARD) if (request.headers.has(h)) headers.set(h, request.headers.get(h));
    const session = (request.headers.get('cookie') || '').split(';').map(c => c.trim()).find(c => c.startsWith(`${SESSION_COOKIE}=`));
    if (session) headers.set('cookie', session);

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

export default async request => createProxy({ workerOrigin: env('SB_WORKER_ORIGIN') })(request);
