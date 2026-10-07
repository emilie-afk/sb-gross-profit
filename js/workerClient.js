/**
 * workerClient.js — the dashboard's ONLY way to reach the SB GP Worker
 * ===================================================================
 * Calls the dashboard's own origin (/api/v1/...), which the Netlify edge
 * function api-proxy.js forwards to the Worker. Same-origin is what lets the
 * Worker's SameSite=Strict, HttpOnly session cookie travel; the browser never
 * sees the cookie, a secret or a Worker URL. The manual workflow stays the
 * default; the read-only weekly automation status (Reports screen) and the read-only automated
 * weekly reports (upload screen, js/weeklyReports.js) use this client.
 */
export const API_BASE = '/api/v1';

export class WorkerApiError extends Error {
  constructor(status, code, message, detail = null) { super(message); this.status = status; this.code = code; this.detail = detail; }
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
  if (!res.ok) throw new WorkerApiError(res.status, data?.error || 'http_error', data?.message || `HTTP ${res.status}`, data?.detail || null);
  return data;
}

export const login = (password, o) => workerApi('/auth/login', { method: 'POST', body: { password }, ...o });
export const logout = o => workerApi('/auth/logout', { method: 'POST', body: {}, ...o });
export const session = o => workerApi('/auth/session', o);
export const weeks = o => workerApi('/weeks', o);
export const snapshot = (weekStart, o) => workerApi(`/snapshot/${weekStart}`, o);
/** A week's orders, one page at a time (the Worker serves at most 100 per page). */
export const orders = (weekStart, { offset = 0, limit = 100, sort = 'date_asc' } = {}, o) =>
  workerApi(`/snapshot/${weekStart}/orders?offset=${Number(offset) || 0}&limit=${Math.min(100, Number(limit) || 100)}&sort=${encodeURIComponent(sort)}`, o);
/** One order with its line items. */
export const order = (weekStart, orderName, o) => workerApi(`/snapshot/${weekStart}/orders/${encodeURIComponent(orderName)}`, o);
/** A week's exact status: pending codes, shipping-report flags, verification (codes and timestamps only). */
export const weekStatus = (weekStart, o) => workerApi(`/weeks/${weekStart}/status`, o);
/** C7: the weekly automation status (codes and timestamps only). */
export const automationStatus = (weekStart, o) => workerApi(`/automation/status${weekStart ? `?weekStart=${encodeURIComponent(weekStart)}` : ''}`, o);
/**
 * Part k of a week's stored results (≤ 40 orders and their lines, rows as stored), for the report view.
 * `snapshotId` pins the revision the report started from (409 snapshot_changed if it moved).
 */
export const reportPart = (weekStart, k, snapshotId, o) =>
  workerApi(`/snapshot/${weekStart}/report-part/${Number(k) || 0}${snapshotId ? `?snapshot=${encodeURIComponent(snapshotId)}` : ''}`, o);
/** Air Plant Shop scenario input for a published week (the line-item export's per-order mapping; separate from results). */
export const apsInput = (weekStart, o) => workerApi(`/aps/${weekStart}`, o);
