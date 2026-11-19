/**
 * http.js — responses, errors, CORS and body parsing for the Worker.
 */

export class ApiError extends Error {
  constructor(status, code, message, detail = undefined) {
    super(message);
    this.status = status; this.code = code; this.detail = detail;
  }
}

const SECURITY_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...SECURITY_HEADERS, ...headers } });
}
/** A JSON body already serialized (same headers as json()). */
export function jsonText(text, status = 200, headers = {}) {
  return new Response(text, { status, headers: { ...SECURITY_HEADERS, ...headers } });
}

/**
 * D1's Free-plan daily limit errors (documented text, enforced from 2026-09-01): every query fails
 * until 00:00 UTC. → { limit: 'read' | 'write', resetAt } or null. Looks through wrapped causes.
 */
export const D1_LIMIT_RE = /exceeded D1's free tier daily row (read|write) limit/i;
export function d1DailyLimit(err, now = new Date()) {
  for (let e = err, i = 0; e && i < 5; e = e.cause, i++) {
    const m = D1_LIMIT_RE.exec(String(e?.message || ''));
    if (m) {
      const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
      return { limit: m[1].toLowerCase(), resetAt: reset.toISOString() };
    }
  }
  return null;
}

export function errorResponse(err, runId = null, now = new Date()) {
  // The account's D1 daily allowance is used up: a distinct, safe service-unavailable answer with the
  // reset time (never a credential or routing error; no internal text).
  const q = err instanceof ApiError ? null : d1DailyLimit(err, now);
  if (q) {
    const retry = Math.max(60, Math.ceil((Date.parse(q.resetAt) - now.getTime()) / 1000));
    return json({ error: 'd1_daily_limit_reached', message: 'The reporting database has reached its daily allowance; it resets at 00:00 UTC', runId,
                  detail: { limit: q.limit, resetAt: q.resetAt } }, 503, { 'Retry-After': String(retry) });
  }
  if (err instanceof ApiError) {
    return json({ error: err.code, message: err.message, runId, ...(err.detail ? { detail: err.detail } : {}) }, err.status);
  }
  // Never echo internal error text: it can contain SQL or payload fragments.
  return json({ error: 'internal_error', message: 'Unexpected server error', runId }, 500);
}

/** Exact-match origin allowlist from ALLOWED_ORIGINS (comma-separated). No wildcards. */
export function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  const list = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : null;
}

export function withCors(response, request, env) {
  const origin = allowedOrigin(request, env);
  if (!origin) return response;                 // unlisted origin: no CORS headers at all
  const r = new Response(response.body, response);
  r.headers.set('Access-Control-Allow-Origin', origin);
  r.headers.set('Access-Control-Allow-Credentials', 'true');
  r.headers.set('Vary', 'Origin');
  return r;
}

export function preflight(request, env) {
  const origin = allowedOrigin(request, env);
  if (!origin) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin',
  } });
}

export const MAX_BODY_BYTES = 25 * 1024 * 1024;

export async function readJson(request) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY_BYTES) throw new ApiError(413, 'payload_too_large', 'Request body too large; send smaller batches');
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new ApiError(413, 'payload_too_large', 'Request body too large; send smaller batches');
  try { return text ? JSON.parse(text) : {}; }
  catch { throw new ApiError(400, 'bad_payload', 'Body is not valid JSON'); }
}

export function intParam(url, name, def, { min = 0, max = Infinity } = {}) {
  const v = url.searchParams.get(name);
  if (v === null || v === '') return def;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < min || n > max) throw new ApiError(400, 'bad_query', `${name} must be an integer between ${min} and ${max}`);
  return n;
}

export const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;
