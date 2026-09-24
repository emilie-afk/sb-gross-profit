/**
 * auth.js — three credential classes, never interchangeable
 * ========================================================
 *   ingest   X-Ingest-Secret   Make scenarios      /v1/ingest/*
 *   admin    X-Admin-Secret    operator, Make S4   /v1/admin/*
 *   session  sb_session cookie dashboard browser   /v1/weeks, /v1/snapshot/*, /v1/history, /v1/compare
 *
 * The dashboard password is stored only as a PBKDF2-SHA256 hash
 * (DASHBOARD_PASSWORD_HASH). Sessions are HMAC-SHA256-signed, short-lived, and
 * revocable on logout. Login attempts are rate limited per keyed IP hash. No
 * D1 or secret value ever reaches the browser.
 */
import { ApiError, json, readJson } from './http.js';
import { nowIso, newId } from './db.js';

export const SESSION_COOKIE = 'sb_session';
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
/** Optional SESSION_TTL_SECONDS var (60 s – 12 h) so staging can test expiry; production leaves it unset (12 h). */
export const sessionTtl = env => Math.min(Math.max(parseInt(env?.SESSION_TTL_SECONDS, 10) || SESSION_TTL_SECONDS, 60), SESSION_TTL_SECONDS);
export const LOGIN_WINDOW_MINUTES = 15;
export const LOGIN_MAX_FAILURES = 10;
// Cloudflare Workers caps PBKDF2 at 100,000 iterations.
export const PBKDF2_ITERATIONS = 100_000;

const enc = new TextEncoder();
const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

/** Constant-time comparison of two byte arrays or strings. */
export function timingSafeEqual(a, b) {
  const x = typeof a === 'string' ? enc.encode(a) : a;
  const y = typeof b === 'string' ? enc.encode(b) : b;
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

/** "pbkdf2_sha256$<iterations>$<salt b64>$<hash b64>" — generate with tools/hash-password.mjs. */
export async function hashPassword(password, { iterations = PBKDF2_ITERATIONS, salt = crypto.getRandomValues(new Uint8Array(16)) } = {}) {
  const h = await pbkdf2(password, salt, iterations);
  return `pbkdf2_sha256$${iterations}$${b64(salt)}$${b64(h)}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
  const iterations = parseInt(parts[1], 10);
  if (!(iterations > 0 && iterations <= PBKDF2_ITERATIONS)) return false;
  const h = await pbkdf2(String(password ?? ''), fromB64(parts[2]), iterations);
  return timingSafeEqual(h, fromB64(parts[3]));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function hmac(secret, data) {
  return new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data)));
}

function assertConfigured(env) {
  const need = ['INGEST_SECRET', 'ADMIN_SECRET', 'SESSION_SIGNING_KEY', 'DASHBOARD_PASSWORD_HASH'];
  const missing = need.filter(k => !env[k]);
  if (missing.length) throw new ApiError(500, 'misconfigured', `Worker secrets not set: ${missing.join(', ')}`);
  for (const k of ['INGEST_SECRET', 'ADMIN_SECRET', 'SESSION_SIGNING_KEY']) {
    if (String(env[k]).length < 32) throw new ApiError(500, 'misconfigured', `${k} must be at least 32 characters`);
  }
  const vals = [env.INGEST_SECRET, env.ADMIN_SECRET, env.SESSION_SIGNING_KEY];
  if (new Set(vals).size !== vals.length) throw new ApiError(500, 'misconfigured', 'Ingest, admin and session secrets must all differ');
}

/** Throws unless the request carries the secret for exactly this credential class. */
export function requireSecret(request, env, cls) {
  assertConfigured(env);
  const header = cls === 'ingest' ? 'X-Ingest-Secret' : 'X-Admin-Secret';
  const expected = cls === 'ingest' ? env.INGEST_SECRET : env.ADMIN_SECRET;
  const got = request.headers.get(header) || '';
  if (!got || !timingSafeEqual(got, expected)) {
    throw new ApiError(401, cls === 'ingest' ? 'ingest_auth' : 'admin_auth', `Missing or invalid ${header}`);
  }
}

export async function signSession(env, { ttl = SESSION_TTL_SECONDS, now = Date.now() } = {}) {
  const payload = { sub: 'dashboard', iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + ttl, jti: newId('ses') };
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return { token: `${body}.${b64url(await hmac(env.SESSION_SIGNING_KEY, body))}`, payload };
}

export async function verifySessionToken(env, token, { now = Date.now() } = {}) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expected = await hmac(env.SESSION_SIGNING_KEY, body);
  let got; try { got = fromB64url(sig); } catch { return null; }
  if (!timingSafeEqual(got, expected)) return null;
  let payload; try { payload = JSON.parse(new TextDecoder().decode(fromB64url(body))); } catch { return null; }
  if (payload.sub !== 'dashboard' || !(payload.exp > now / 1000)) return null;
  const revoked = await env.DB.prepare('SELECT 1 AS r FROM session_revocation WHERE jti = ?1').bind(payload.jti).first();
  return revoked ? null : payload;
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function cookie(env, value, maxAge) {
  const sameSite = ['Strict', 'Lax', 'None'].includes(env.COOKIE_SAMESITE) ? env.COOKIE_SAMESITE : 'Strict';
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=${sameSite}; Max-Age=${maxAge}`;
}

export async function requireSession(request, env) {
  assertConfigured(env);
  const payload = await verifySessionToken(env, readCookie(request, SESSION_COOKIE));
  if (!payload) throw new ApiError(401, 'session_expired', 'Sign in again');
  return payload;
}

/** Session OR admin secret. Admin callers may read drafts; sessions only published snapshots. */
export async function requireReader(request, env) {
  if (request.headers.get('X-Admin-Secret')) { requireSecret(request, env, 'admin'); return { admin: true }; }
  await requireSession(request, env);
  return { admin: false };
}

async function ipHash(env, request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  return b64url(await hmac(env.SESSION_SIGNING_KEY, `ip:${ip}`)).slice(0, 32);
}

export async function login(request, env) {
  assertConfigured(env);
  const ip = await ipHash(env, request);
  const since = new Date(Date.now() - LOGIN_WINDOW_MINUTES * 60_000).toISOString();
  // Record the attempt as a failure BEFORE counting, so parallel attempts all
  // see each other and a burst cannot exceed the limit. A success rewrites it.
  const ins = await env.DB.prepare('INSERT INTO auth_attempt (attempt_at, ip_hash, outcome) VALUES (?1, ?2, ?3)').bind(nowIso(), ip, 'fail').run();
  const attemptId = ins.meta.last_row_id;
  const fails = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM auth_attempt WHERE ip_hash = ?1 AND attempt_at >= ?2 AND outcome IN ('fail','limited') AND id <= ?3")
    .bind(ip, since, attemptId).first();
  if ((fails?.n || 0) > LOGIN_MAX_FAILURES) {
    await env.DB.prepare("UPDATE auth_attempt SET outcome = 'limited' WHERE id = ?1").bind(attemptId).run();
    throw new ApiError(429, 'rate_limited', `Too many attempts; try again in ${LOGIN_WINDOW_MINUTES} minutes`);
  }
  const body = await readJson(request);
  const ok = await verifyPassword(body.password, env.DASHBOARD_PASSWORD_HASH);
  if (ok) await env.DB.prepare("UPDATE auth_attempt SET outcome = 'ok' WHERE id = ?1").bind(attemptId).run();
  if (!ok) throw new ApiError(401, 'invalid_credentials', 'Incorrect password');
  const { token, payload } = await signSession(env, { ttl: sessionTtl(env) });
  return json({ ok: true, expiresAt: new Date(payload.exp * 1000).toISOString() }, 200,
              { 'Set-Cookie': cookie(env, token, sessionTtl(env)) });
}

export async function logout(request, env) {
  assertConfigured(env);
  const payload = await verifySessionToken(env, readCookie(request, SESSION_COOKIE));
  if (payload) {
    await env.DB.prepare('INSERT OR IGNORE INTO session_revocation (jti, revoked_at, expires_at) VALUES (?1, ?2, ?3)')
      .bind(payload.jti, nowIso(), new Date(payload.exp * 1000).toISOString()).run();
  }
  return json({ ok: true }, 200, { 'Set-Cookie': cookie(env, '', 0) });
}

export async function sessionInfo(request, env) {
  const p = await requireSession(request, env);
  return json({ ok: true, expiresAt: new Date(p.exp * 1000).toISOString() });
}
