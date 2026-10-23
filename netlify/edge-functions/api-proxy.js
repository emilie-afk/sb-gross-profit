/**
 * Netlify Edge Function — same-origin proxy to the SB GP Worker
 * =============================================================
 *   browser  →  https://<dashboard>/api/v1/<route>  →  <SB_WORKER_ORIGIN>/v1/<route>
 *
 * What it forwards, and nothing else:
 *   - dashboard read routes only (GET): published reads, verified provisional reads (?provisional=1),
 *     report parts, the Air Plant Shop input and the weekly automation status. /v1/ingest/*, /v1/admin/*,
 *     /v1/gate/*, /v1/collect/* and /v1/verify/* are not reachable through the browser path. The Worker's
 *     own sign-in routes (/v1/auth/*) are not proxied either: behind the proxy every browser shares one
 *     address, so their per-client attempt limit would lock every member of staff out at once.
 *   - headers: Accept only. No browser cookie, X-* header or client IP header is forwarded.
 *
 * One sign-in: the site password. The proxy verifies the signed gate session itself (shared/gateSession.js),
 * so it is safe whatever order Netlify runs the edge functions in. Only for a valid session does it attach the
 * Worker's dashboard reader secret and the session id (X-Gate-Session); the Worker refuses a session revoked
 * at logout. Without a valid session nothing reaches the Worker. Every answer is private and never cached.
 *
 * Configuration (Netlify environment): SB_WORKER_ORIGIN (https://<worker host>; unset → 503),
 * SB_WORKER_READER_SECRET (= the Worker's DASHBOARD_READER_SECRET; unset → 503), and the gate's
 * SITE_PASSWORD, GATE_SIGNING_KEY and GATE_SESSION_EPOCH.
 */
import { GATE_COOKIE, readCookie, verifyGateToken, gateConfigProblem, PRIVATE_HEADERS, edgeEnv } from '../../shared/gateSession.js';

const ROUTES = [
  /^\/v1\/(weeks|history|compare)$/,
  /^\/v1\/automation\/status$/,
  /^\/v1\/weeks\/\d{4}-\d{2}-\d{2}\/status$/,
  /^\/v1\/snapshot\/\d{4}-\d{2}-\d{2}(\/(orders(\/[^/]+)?|issues|scenario-input))?$/,
  /^\/v1\/snapshot\/\d{4}-\d{2}-\d{2}\/report-part\/\d{1,4}$/,
  /^\/v1\/aps\/\d{4}-\d{2}-\d{2}$/,
];
const RETURN = ['content-type', 'x-content-type-options', 'referrer-policy'];
const READER_HEADER = 'x-dashboard-reader-secret';
const GATE_SESSION_HEADER = 'x-gate-session';

const reply = (status, error, message) => new Response(JSON.stringify({ error, message }), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...PRIVATE_HEADERS } });

export function createProxy({ workerOrigin, readerSecret, sitePassword, signingKey, epoch, fetchImpl = fetch, now = () => Date.now() }) {
  return async function proxy(request) {
    if (!workerOrigin || !/^https:\/\/[^/]+$/.test(workerOrigin) || !readerSecret) return reply(503, 'proxy_not_configured', 'The report service is not configured');
    if (gateConfigProblem({ sitePassword, signingKey })) return reply(503, 'proxy_not_configured', 'The report service is not configured');
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api(?=\/v1\/)/, '').replace(/\/+$/, '');
    if (request.method !== 'GET' || !ROUTES.some(re => re.test(path))) return reply(404, 'not_found', 'No such route');

    const session = await verifyGateToken(readCookie(request, GATE_COOKIE), { signingKey, epoch, now: now() });
    if (!session) return reply(401, 'signed_out', 'Sign in again');

    const headers = new Headers({ [READER_HEADER]: readerSecret, [GATE_SESSION_HEADER]: session.jti });
    if (request.headers.has('accept')) headers.set('accept', request.headers.get('accept'));
    let upstream;
    try { upstream = await fetchImpl(new Request(`${workerOrigin}${path}${url.search}`, { method: 'GET', headers, redirect: 'manual' })); }
    catch { return reply(502, 'upstream_unavailable', 'The report service could not be reached'); }
    const out = new Headers(PRIVATE_HEADERS);
    for (const h of RETURN) if (upstream.headers.has(h)) out.set(h, upstream.headers.get(h));
    return new Response(upstream.body, { status: upstream.status, headers: out });
  };
}

export default async request => createProxy({ workerOrigin: edgeEnv('SB_WORKER_ORIGIN'), readerSecret: edgeEnv('SB_WORKER_READER_SECRET'),
  sitePassword: edgeEnv('SITE_PASSWORD'), signingKey: edgeEnv('GATE_SIGNING_KEY'), epoch: edgeEnv('GATE_SESSION_EPOCH') })(request);

export const config = {
  path: '/api/v1/*',
  // Coarse abuse ceiling per client address (Netlify code-based rule; approximate by design). A multi-week
  // report loads one part per 40 orders, 4 at a time, for every week, and staff can share one office
  // address, so the ceiling sits far above normal use: it stops floods, not report loading.
  rateLimit: { windowLimit: 3000, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
