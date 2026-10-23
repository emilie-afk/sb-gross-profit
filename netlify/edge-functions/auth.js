/**
 * Netlify Edge Function — site-password gate (every path except sign-in, the API proxy and gp-verify)
 * ==================================================================================================
 * Without a valid gate session only the sign-in page is returned. The session is a signed, expiring
 * token (shared/gateSession.js), never a function of the password:
 *   - expiry checked here on every request (8 hours); GATE_SESSION_EPOCH signs everyone out;
 *   - /__logout records the token id in the Worker, so a copied token is refused for the cost data
 *     files and every report read. Pages and scripts are public code: a revoked, unexpired token
 *     still loads them until it expires (disclosed limitation).
 * Sign-in itself is netlify/edge-functions/auth-login.js; the API proxy (api-proxy.js) checks the
 * same token on its own, so the order in which Netlify runs the functions does not matter.
 *
 * Netlify environment (all required; a missing one answers 503 and opens nothing):
 *   SITE_PASSWORD           the one dashboard password
 *   GATE_SIGNING_KEY        ≥ 32 random characters; signs gate sessions and hashes client addresses
 *   GATE_SESSION_EPOCH      optional, default "1"; change it to sign every browser out
 *   SB_WORKER_ORIGIN        https://<worker host>
 *   SB_WORKER_GATE_SECRET   = the Worker's GATE_SECRET (sign-in attempts and revocations only)
 */
import { GATE_COOKIE, readCookie, verifyGateToken, gateConfigProblem, gateWorker, clearGateCookie, PRIVATE_HEADERS, edgeEnv } from '../../shared/gateSession.js';
import { loginPage, unavailable, GATE_MESSAGES } from '../../shared/gatePage.js';

/** Paths that carry private data: checked against the revocation list, never cached. */
const SENSITIVE = /^\/(data\/[^/]+\.json|api\/mcg-extra)$/;
const REVOCATION_CACHE_MS = 60_000;
const REVOCATION_CACHE_MAX = 1000;

export function createGate({ env = edgeEnv, fetchImpl = fetch, now = () => Date.now(), cache = new Map() } = {}) {
  const cfg = () => ({ sitePassword: env('SITE_PASSWORD'), signingKey: env('GATE_SIGNING_KEY'), epoch: env('GATE_SESSION_EPOCH') });
  const worker = () => gateWorker({ workerOrigin: env('SB_WORKER_ORIGIN'), gateSecret: env('SB_WORKER_GATE_SECRET'), fetchImpl });

  /** Revoked? Cached per edge instance for up to 60 s (a revocation, once seen, until the token expires). */
  async function revoked(p) {
    const hit = cache.get(p.jti);
    if (hit && (hit.revoked || now() - hit.at < REVOCATION_CACHE_MS)) return hit.revoked;
    const r = await worker().isRevoked(p.jti);
    if (cache.size >= REVOCATION_CACHE_MAX) cache.clear();
    cache.set(p.jti, { revoked: r, at: now() });
    return r;
  }

  return async function gate(request, context) {
    const c = cfg();
    if (gateConfigProblem(c)) return unavailable();
    const url = new URL(request.url);
    const session = await verifyGateToken(readCookie(request, GATE_COOKIE), { signingKey: c.signingKey, epoch: c.epoch, now: now() });

    if (url.pathname === '/__logout') {
      let message = '';
      if (session) {
        try { await worker().revoke(session.jti, session.exp); cache.set(session.jti, { revoked: true, at: now() }); }
        catch { message = GATE_MESSAGES.signed_out_unrecorded; }
      }
      if (message) return loginPage(message, 200, { 'Set-Cookie': clearGateCookie() });
      return new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': clearGateCookie(), ...PRIVATE_HEADERS } });
    }

    if (!session) return loginPage();

    if (SENSITIVE.test(url.pathname)) {
      let isRevoked;
      try { isRevoked = await revoked(session); } catch { return unavailable(); }
      if (isRevoked) return loginPage('', 200, { 'Set-Cookie': clearGateCookie() });
      if (url.pathname === '/api/mcg-extra') return mcgExtra(env, fetchImpl);
      const res = await context.next();
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(PRIVATE_HEADERS)) out.headers.set(k, v);
      return out;
    }
    return context.next();
  };
}

/**
 * /api/mcg-extra — the extra MCG cost sheet, parsed on the server (removed in step 4 of the
 * confidentiality plan: the catalog already carries it). A failure is a plain 502: no status text,
 * column names, exception message or address ever reaches the browser.
 */
async function mcgExtra(env, fetchImpl) {
  const headers = { 'Content-Type': 'application/json', ...PRIVATE_HEADERS };
  const failed = () => new Response(JSON.stringify({ error: 'mcg_extra_unavailable' }), { status: 502, headers });
  const sheetUrl = env('MCG_EXTRA_SHEET_URL');
  if (!sheetUrl) return new Response('{}', { status: 200, headers });
  let csv;
  try { const r = await fetchImpl(sheetUrl); if (!r.ok) return failed(); csv = await r.text(); } catch { return failed(); }
  const lines = csv.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return failed();
  const head = parseCSVLine(lines[0]).map(h => h.trim().toUpperCase());
  const skuIdx = head.indexOf('SKU'), costIdx = head.indexOf('COST PER ITEM'), descIdx = head.indexOf('DESCRIPTION');
  if (skuIdx === -1 || costIdx === -1) return failed();
  const result = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const sku = (cols[skuIdx] || '').trim().toUpperCase();
    const cost = parseFloat(cols[costIdx] || '');
    if (!sku || isNaN(cost) || cost <= 0) continue;
    result[sku] = cost;
    // Also index by normalized plant name (strip SKU prefix + variant suffix) so variant SKUs not in the sheet can match by name.
    if (descIdx !== -1) {
      const desc = (cols[descIdx] || '').replace(/^[A-Z0-9]{4,}\s+/i, '');
      const name = desc.split('/')[0].toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
      if (name) result['__n__' + name] = cost;
    }
  }
  return new Response(JSON.stringify(result), { status: 200, headers });
}

// Minimal CSV line parser (handles quoted fields)
function parseCSVLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; }
    else if (c === ',' && !inQ) { result.push(cur); cur = ''; }
    else { cur += c; }
  }
  result.push(cur);
  return result;
}

const gate = createGate();
export default (request, context) => gate(request, context);

export const config = {
  path: '/*',
  excludedPath: ['/__auth', '/api/v1/*', '/.netlify/functions/gp-verify', '/.netlify/functions/gp-verify-background'],
  // Broad traffic throttle per client (Netlify code-based rule; approximate by design). Failed-password
  // lockouts are separate and exact: auth-login.js + the Worker's counter.
  rateLimit: { windowLimit: 600, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};
