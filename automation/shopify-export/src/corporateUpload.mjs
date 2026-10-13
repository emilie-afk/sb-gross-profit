/**
 * corporateUpload.mjs — deliver the reduced corporate-gifting orders payload ("sbcg-orders-v1")
 * ==============================================================================================
 * POST <corporateIngestUrl>                 (https://<site>/api/ingest/shopify-orders)
 *   Authorization: Bearer <secret>          (Windows Credential Manager target sb-corporate-ingest)
 *   body: the JSON built by corporateOrders.mjs from the same in-memory export the GP step uses
 *
 * Independent of the GP upload: collect.mjs records the result in `manifest.corporate` only, and
 * nothing here can change the GP status or exit code. Retries are safe (re-sending the same
 * export is a no-op on the app): network errors and 5xx are retried, any 4xx is a final answer.
 * Only whitelisted counts are kept from the response; the secret, the payload and the response
 * body are never returned, logged or stored.
 */

export const CORPORATE_INGEST_PATH = '/api/ingest/shopify-orders';
/** The app's limit is 6 MB (Netlify synchronous functions); stay under it rather than collect a 413. */
export const CORPORATE_MAX_BYTES = 6_000_000;
/** Response fields kept in the manifest. Everything else in the response is ignored. */
export const CORPORATE_COUNT_KEYS = Object.freeze(['status', 'received', 'new', 'updated', 'unchanged', 'stale', 'rejected', 'warnings']);

/** The validated endpoint: https, no credentials/query/fragment, path ending in /api/ingest/shopify-orders. */
export function corporateIngestEndpoint(url) {
  const msg = `corporateIngestUrl must be an https URL ending in ${CORPORATE_INGEST_PATH}`;
  let u; try { u = new URL(String(url)); } catch { throw new Error(msg); }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || !u.pathname.endsWith(CORPORATE_INGEST_PATH)) throw new Error(msg);
  return u.toString();
}

const sleepMs = ms => new Promise(r => setTimeout(r, ms));

/** Counts only: numbers as they are, `status` as a short code, a `warnings` list as its length. */
export function pickCorporateCounts(j) {
  if (!j || typeof j !== 'object') return null;
  const out = {};
  for (const k of CORPORATE_COUNT_KEYS) {
    const v = j[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (k === 'status' && typeof v === 'string' && /^[a-z_]{1,32}$/.test(v)) out[k] = v;
    else if (k === 'warnings' && Array.isArray(v)) out[k] = v.length;
  }
  return out;
}

/**
 * @param {object} o
 * @param {string} o.url       corporateIngestUrl (validated again here)
 * @param {string} o.secret    bearer secret, read from Credential Manager by the caller
 * @param {string} o.body      the serialized payload
 * @returns {{ ok: boolean, httpStatus: number|null, attempts: number, counts?: object, error?: string }}
 */
export async function uploadCorporateOrders({ url, secret, body, fetchImpl = fetch, attempts = 3, backoffMs = 5000, timeoutMs = 60_000, sleep = sleepMs }) {
  const endpoint = corporateIngestEndpoint(url);
  if (!secret) throw new Error('Missing corporate ingest secret');
  if (typeof body !== 'string') throw new Error('The corporate payload must be serialized JSON');
  let last = { ok: false, httpStatus: null, attempts: 0, error: 'not_attempted' };
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST', body, redirect: 'error',                              // the secret never follows a redirect
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        let j = null; try { j = await res.json(); } catch { /* not JSON: counts unknown */ }
        return { ok: true, httpStatus: res.status, attempts: i, counts: pickCorporateCounts(j) };
      }
      try { await res.body?.cancel(); } catch { /* the body is never read */ }
      last = { ok: false, httpStatus: res.status, attempts: i, error: `http_${res.status}` };
      if (res.status < 500) return last;                                       // 4xx: a final answer, never retried
    } catch {
      last = { ok: false, httpStatus: null, attempts: i, error: 'network_error' };
    }
    if (i < attempts) await sleep(backoffMs * 2 ** (i - 1));
  }
  return last;
}
