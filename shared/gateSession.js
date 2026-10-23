/**
 * gateSession.js — the dashboard's site-password session, shared by the Netlify edge
 * functions (auth.js, auth-login.js, api-proxy.js) and their tests.
 * ===================================================================================
 * The gate cookie is a signed, expiring token, never a function of the password:
 *
 *   __gp_session = g1.<base64url(payload)>.<base64url(HMAC-SHA256(GATE_SIGNING_KEY, "g1." + payload))>
 *   payload      = { jti: "gat_<32 hex>", iat, exp, ep }      (seconds; ep = GATE_SESSION_EPOCH)
 *
 *   - expiry is checked on the server on every request (8 hours);
 *   - bumping GATE_SESSION_EPOCH signs every browser out at once;
 *   - logout records the jti in the Worker's session_revocation table, so a copied token
 *     is refused for the data files and every report read (auth.js, api-proxy.js).
 *
 * Pure WebCrypto: runs unchanged on Netlify's Deno edge runtime and in Node tests.
 * Nothing here logs, and no function returns a secret.
 */
export const GATE_COOKIE = '__gp_session';
export const GATE_TTL_SECONDS = 8 * 60 * 60;
export const GATE_TOKEN_VERSION = 'g1';
export const MIN_KEY_LENGTH = 32;
const JTI_RE = /^gat_[0-9a-f]{32}$/;
const CLOCK_SKEW_SECONDS = 300;

const enc = new TextEncoder();
const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = s => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4)), c => c.charCodeAt(0));

export const isGateJti = s => JTI_RE.test(String(s || ''));

/** Constant-time comparison of two strings or byte arrays. */
export function sameBytes(a, b) {
  const x = typeof a === 'string' ? enc.encode(a) : a, y = typeof b === 'string' ? enc.encode(b) : b;
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}

/** Why this gate configuration is unusable (a short code), or null. Missing configuration never opens the site. */
export function gateConfigProblem({ sitePassword, signingKey } = {}) {
  if (!sitePassword) return 'site_password_unset';
  if (!signingKey) return 'signing_key_unset';
  if (String(signingKey).length < MIN_KEY_LENGTH) return 'signing_key_short';
  if (String(signingKey) === String(sitePassword)) return 'signing_key_is_password';
  return null;
}

const epochOf = e => String(e ?? '').trim() || '1';
const randomHex = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('');

/** A new token. `now` in milliseconds. */
export async function signGateToken({ signingKey, epoch, now = Date.now(), ttl = GATE_TTL_SECONDS }) {
  const iat = Math.floor(now / 1000);
  const payload = { jti: `gat_${randomHex(16)}`, iat, exp: iat + ttl, ep: epochOf(epoch) };
  const body = `${GATE_TOKEN_VERSION}.${b64url(enc.encode(JSON.stringify(payload)))}`;
  return { token: `${body}.${b64url(await hmac(signingKey, body))}`, payload };
}

/** The token's payload when its signature, expiry and epoch hold; otherwise null. */
export async function verifyGateToken(token, { signingKey, epoch, now = Date.now() }) {
  if (!signingKey || typeof token !== 'string' || token.length > 1024) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== GATE_TOKEN_VERSION) return null;
  const body = `${parts[0]}.${parts[1]}`;
  let sig; try { sig = fromB64url(parts[2]); } catch { return null; }
  if (!sameBytes(sig, await hmac(signingKey, body))) return null;
  let p; try { p = JSON.parse(new TextDecoder().decode(fromB64url(parts[1]))); } catch { return null; }
  const t = now / 1000;
  if (!p || !isGateJti(p.jti) || !Number.isInteger(p.iat) || !Number.isInteger(p.exp)) return null;
  if (!(p.exp > t) || p.iat > t + CLOCK_SKEW_SECONDS || p.exp - p.iat > GATE_TTL_SECONDS) return null;
  if (p.ep !== epochOf(epoch)) return null;
  return p;
}

/** Constant-time password check: both sides are reduced to HMAC digests first, so length leaks nothing. */
export async function passwordMatches(entered, sitePassword, signingKey) {
  if (!sitePassword || !signingKey) return false;
  return sameBytes(await hmac(signingKey, `pw:${entered ?? ''}`), await hmac(signingKey, `pw:${sitePassword}`));
}

/** A keyed hash of the client IP: the Worker counts attempts per hash and never sees the address. */
export async function clientIpHash(ip, signingKey) {
  return b64url(await hmac(signingKey, `ip:${ip || 'unknown'}`)).slice(0, 32);
}

/** A same-site path to return to after sign-in, or "/". Never "//host", a backslash, a scheme or a control character. */
export function safeRedirect(r) {
  const s = String(r ?? '');
  if (!s.startsWith('/') || s.startsWith('//') || s.includes('\\') || /[\u0000-\u001f\u007f]/.test(s) || s.length > 512) return '/';
  try { const u = new URL(s, 'https://gate.invalid'); return u.origin === 'https://gate.invalid' ? `${u.pathname}${u.search}` : '/'; } catch { return '/'; }
}

export function readCookie(request, name = GATE_COOKIE) {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export const gateCookie = (token, maxAge) => `${GATE_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
export const clearGateCookie = () => gateCookie('', 0);

/** Headers for every response that carries private data: never stored, never shared between cookies. */
export const PRIVATE_HEADERS = Object.freeze({ 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' });

/** Read a Netlify environment variable in the edge runtime (Netlify.env), Deno, or Node tests. */
export const edgeEnv = name => globalThis.Netlify?.env?.get?.(name) ?? globalThis.Deno?.env?.get?.(name) ?? undefined;

/**
 * The gate's calls to the Worker (X-Gate-Secret): sign-in attempts and revocations only.
 * Every method throws GateWorkerError on a network failure or an unexpected answer, so callers fail closed.
 */
export class GateWorkerError extends Error { constructor(code) { super(code); this.code = code; } }

export function gateWorker({ workerOrigin, gateSecret, fetchImpl = fetch }) {
  const configured = !!gateSecret && String(gateSecret).length >= MIN_KEY_LENGTH && /^https:\/\/[^/]+$/.test(workerOrigin || '');
  const call = async (method, path, body) => {
    if (!configured) throw new GateWorkerError('gate_worker_unconfigured');
    let r;
    try {
      r = await fetchImpl(new Request(`${workerOrigin}${path}`, { method, redirect: 'manual',
        headers: { 'X-Gate-Secret': gateSecret, 'Content-Type': 'application/json', 'User-Agent': 'sb-gp-gate/1.0' },
        body: body === undefined ? undefined : JSON.stringify(body) }));
    } catch { throw new GateWorkerError('gate_worker_unreachable'); }
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, json: j || {} };
  };
  return {
    configured,
    /** → { attemptId } or { limited: true }. Counted BEFORE the password is checked. */
    async beginAttempt(ipHash) {
      const r = await call('POST', '/v1/gate/attempts', { ipHash });
      if (r.status === 429) return { limited: true };
      if (r.status !== 200 || !Number.isInteger(r.json.attemptId)) throw new GateWorkerError(`gate_worker_${r.status}`);
      return { attemptId: r.json.attemptId };
    },
    async attemptSucceeded(attemptId) {
      const r = await call('POST', `/v1/gate/attempts/${attemptId}/ok`, {});
      if (r.status !== 200) throw new GateWorkerError(`gate_worker_${r.status}`);
    },
    async revoke(jti, exp) {
      const r = await call('POST', '/v1/gate/revocations', { jti, exp });
      if (r.status !== 200) throw new GateWorkerError(`gate_worker_${r.status}`);
    },
    async isRevoked(jti) {
      const r = await call('GET', `/v1/gate/revocations/${jti}`);
      if (r.status !== 200 || typeof r.json.revoked !== 'boolean') throw new GateWorkerError(`gate_worker_${r.status}`);
      return r.json.revoked;
    },
  };
}
