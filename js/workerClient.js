/**
 * workerClient.js — the dashboard's ONLY way to reach the SB GP Worker
 * ===================================================================
 * Calls the dashboard's own origin (/api/v1/...), which the Netlify edge
 * function api-proxy.js forwards to the Worker. Same-origin is what lets the
 * Worker's SameSite=Strict, HttpOnly session cookie travel; the browser never
 * sees the cookie, a secret or a Worker URL. The manual workflow stays the
 * default; C7 wires only the read-only weekly automation status (Reports screen).
 */
export const API_BASE = '/api/v1';

export class WorkerApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export async function workerApi(path, { method = 'GET', body, fetchImpl = globalThis.fetch } = {}) {
  if (!path.startsWith('/') || /^\/(admin|ingest)\//.test(path)) throw new Error('Only dashboard routes are reachable from the browser');
  const res = await fetchImpl(`${API_BASE}${path}`, {
    method,
    credentials: 'same-origin',                   // send the session cookie; never cross-origin
    headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new WorkerApiError(res.status, data?.error || 'http_error', data?.message || `HTTP ${res.status}`);
  return data;
}

export const login = (password, o) => workerApi('/auth/login', { method: 'POST', body: { password }, ...o });
export const logout = o => workerApi('/auth/logout', { method: 'POST', body: {}, ...o });
export const session = o => workerApi('/auth/session', o);
export const weeks = o => workerApi('/weeks', o);
export const snapshot = (weekStart, o) => workerApi(`/snapshot/${weekStart}`, o);
/** C7: the weekly automation status (codes and timestamps only). */
export const automationStatus = (weekStart, o) => workerApi(`/automation/status${weekStart ? `?weekStart=${encodeURIComponent(weekStart)}` : ''}`, o);
