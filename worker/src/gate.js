/**
 * gate.js — the site-password gate's server-side state (X-Gate-Secret only)
 * ========================================================================
 * The Netlify gate checks the site password itself; the Worker keeps the two things an edge
 * function cannot keep reliably: an exact, atomic failed-attempt count, and the list of gate
 * sessions revoked at logout. Both reuse existing tables (no migration):
 *
 *   auth_attempt        rows with ip_hash 'g:<keyed hash>' (the gate never sends an address);
 *                       the Worker login's own rows have no prefix, so the two counters never mix
 *   session_revocation  jti 'gat_<32 hex>' (Worker sessions use 'ses_…')
 *
 *   POST /v1/gate/attempts               { ipHash }  → 200 { attemptId } | 429 rate_limited
 *        Recorded as a failure BEFORE counting, exactly like the Worker login, so parallel
 *        attempts see each other and a burst cannot exceed the limit. Per client only: there is
 *        no site-wide ceiling, so nobody can lock every member of staff out.
 *   POST /v1/gate/attempts/:id/ok        → 200 (the password was right; the row stops counting)
 *   POST /v1/gate/revocations            { jti, exp } → 200
 *   GET  /v1/gate/revocations/:jti       → 200 { revoked }
 * Nothing here returns a secret, an address or a report.
 */
import { ApiError, json, readJson } from './http.js';
import { nowIso } from './db.js';
import { LOGIN_WINDOW_MINUTES, LOGIN_MAX_FAILURES } from './auth.js';
import { GATE_TTL_SECONDS } from '../../shared/gateSession.js';

const IP_HASH = /^[A-Za-z0-9_-]{16,64}$/;
const JTI = /^gat_[0-9a-f]{32}$/;
const PREFIX = 'g:';

export async function beginGateAttempt(request, env) {
  const { ipHash } = await readJson(request);
  if (!IP_HASH.test(String(ipHash || ''))) throw new ApiError(400, 'bad_payload', 'ipHash required');
  const key = PREFIX + ipHash;
  const since = new Date(Date.now() - LOGIN_WINDOW_MINUTES * 60_000).toISOString();
  const ins = await env.DB.prepare('INSERT INTO auth_attempt (attempt_at, ip_hash, outcome) VALUES (?1, ?2, ?3)').bind(nowIso(), key, 'fail').run();
  const attemptId = ins.meta.last_row_id;
  const fails = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM auth_attempt WHERE ip_hash = ?1 AND attempt_at >= ?2 AND outcome IN ('fail','limited') AND id <= ?3")
    .bind(key, since, attemptId).first();
  if ((fails?.n || 0) > LOGIN_MAX_FAILURES) {
    await env.DB.prepare("UPDATE auth_attempt SET outcome = 'limited' WHERE id = ?1").bind(attemptId).run();
    throw new ApiError(429, 'rate_limited', `Too many attempts; try again in ${LOGIN_WINDOW_MINUTES} minutes`, { retryAfterSeconds: LOGIN_WINDOW_MINUTES * 60 });
  }
  return json({ attemptId });
}

export async function gateAttemptSucceeded(env, attemptId) {
  const r = await env.DB.prepare("UPDATE auth_attempt SET outcome = 'ok' WHERE id = ?1 AND outcome = 'fail' AND ip_hash LIKE 'g:%'").bind(Number(attemptId)).run();
  if (!r.meta.changes) throw new ApiError(404, 'not_found', 'No such open attempt');
  return json({ ok: true });
}

export async function revokeGateSession(request, env) {
  const { jti, exp } = await readJson(request);
  if (!JTI.test(String(jti || ''))) throw new ApiError(400, 'bad_payload', 'jti required');
  const now = Date.now() / 1000;
  if (!Number.isInteger(exp) || exp <= now - 60 || exp > now + GATE_TTL_SECONDS + 300) throw new ApiError(400, 'bad_payload', 'exp must be the session expiry (seconds)');
  await env.DB.prepare('INSERT OR IGNORE INTO session_revocation (jti, revoked_at, expires_at) VALUES (?1, ?2, ?3)')
    .bind(jti, nowIso(), new Date(exp * 1000).toISOString()).run();
  return json({ ok: true });
}

export async function gateSessionRevoked(env, jti) {
  if (!JTI.test(jti)) throw new ApiError(400, 'bad_payload', 'jti required');
  const r = await env.DB.prepare('SELECT 1 AS r FROM session_revocation WHERE jti = ?1').bind(jti).first();
  return json({ revoked: !!r });
}
