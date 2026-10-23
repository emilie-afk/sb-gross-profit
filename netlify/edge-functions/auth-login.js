/**
 * Netlify Edge Function — site-password sign-in (POST /__auth)
 * ============================================================
 * Two separate protections against password guessing:
 *   1. a native Netlify rate limit on this path (config below): a coarse throttle per client
 *      address, approximate by design (enforcement can lag by seconds);
 *   2. an exact failed-password lockout, counted atomically by the Worker per keyed client-address
 *      hash (worker/src/gate.js): after 10 failures in 15 minutes that client is refused, even with
 *      the right password. There is no site-wide ceiling, so one attacker cannot lock all staff out.
 * The attempt is counted BEFORE the password is compared. If the Worker cannot be reached, sign-in is
 * refused (503): a missing protection never opens the site.
 *
 * On success: a signed, expiring gate session (shared/gateSession.js) and a redirect to a same-site path.
 * Configuration: see auth.js (SITE_PASSWORD, GATE_SIGNING_KEY, GATE_SESSION_EPOCH, SB_WORKER_ORIGIN,
 * SB_WORKER_GATE_SECRET).
 */
import { gateConfigProblem, gateWorker, passwordMatches, clientIpHash, signGateToken, gateCookie, safeRedirect,
         GATE_TTL_SECONDS, PRIVATE_HEADERS, edgeEnv } from '../../shared/gateSession.js';
import { loginPage, unavailable, GATE_MESSAGES } from '../../shared/gatePage.js';

const MAX_FORM_BYTES = 4096;

export function createLogin({ env = edgeEnv, fetchImpl = fetch, now = () => Date.now() } = {}) {
  return async function login(request, context) {
    if (request.method !== 'POST') return new Response(null, { status: 303, headers: { Location: '/', ...PRIVATE_HEADERS } });
    const c = { sitePassword: env('SITE_PASSWORD'), signingKey: env('GATE_SIGNING_KEY'), epoch: env('GATE_SESSION_EPOCH') };
    const worker = gateWorker({ workerOrigin: env('SB_WORKER_ORIGIN'), gateSecret: env('SB_WORKER_GATE_SECRET'), fetchImpl });
    if (gateConfigProblem(c) || !worker.configured) return unavailable();

    let body = '';
    try { body = await request.text(); } catch {}
    if (body.length > MAX_FORM_BYTES) return loginPage(GATE_MESSAGES.wrong_password, 400);
    const form = new URLSearchParams(body);

    let attempt;
    try { attempt = await worker.beginAttempt(await clientIpHash(context?.ip, c.signingKey)); }
    catch { return unavailable(); }
    if (attempt.limited) return loginPage(GATE_MESSAGES.locked, 429, { 'Retry-After': '900' });

    if (!(await passwordMatches(form.get('password') || '', c.sitePassword, c.signingKey))) return loginPage(GATE_MESSAGES.wrong_password, 401);

    // Right password: stop counting this attempt. If that call fails the attempt simply stays counted.
    try { await worker.attemptSucceeded(attempt.attemptId); } catch {}
    const { token } = await signGateToken({ signingKey: c.signingKey, epoch: c.epoch, now: now() });
    return new Response(null, { status: 303, headers: { Location: safeRedirect(form.get('redirect')), 'Set-Cookie': gateCookie(token, GATE_TTL_SECONDS), ...PRIVATE_HEADERS } });
  };
}

const login = createLogin();
export default (request, context) => login(request, context);

export const config = {
  path: '/__auth',
  // Native throttle (Netlify code-based rule, per client address): bursts get 429 before any password check.
  rateLimit: { windowLimit: 10, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
