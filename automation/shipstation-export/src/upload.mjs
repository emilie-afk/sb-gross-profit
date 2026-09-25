/**
 * upload.mjs — deliver the validated ShipStation CSV to the Worker
 * =================================================================
 * POST <workerUrl>/v1/ingest/shipstation
 *   { format: 'csv_text', text, weekStart, sanitizedSha256, exportedAt, sourceFormat: 'custom' }
 *   header X-Ingest-Secret (read from Windows Credential Manager at run time)
 *
 * Retries are safe: the Worker stores shipments by content hash, and identical
 * content comes back as `sourceStatus: 'source_no_change'`. Only network errors,
 * 429 and 5xx are retried; any other 4xx is a permanent answer and stops.
 * Nothing here logs the CSV, the secret or a response body.
 */
import crypto from 'node:crypto';

export const UPLOAD_EXIT = 31;                               // export fine, delivery to the Worker failed

export function workerEndpoint(workerUrl) {
  let u;
  try { u = new URL(workerUrl); } catch { throw new Error('workerUrl must be an https URL'); }
  if (u.protocol !== 'https:') throw new Error('workerUrl must be an https URL');
  return `${u.origin}/v1/ingest/shipstation`;
}

const sleepMs = ms => new Promise(r => setTimeout(r, ms));
const retryable = status => status === 429 || status >= 500;

/**
 * @returns {{ ok, httpStatus, attempts, sourceStatus?, sourceHash?, runId?, rowsWritten?, duplicates?, error? }}
 */
export async function uploadShipStationCsv({ workerUrl, ingestSecret, weekStart, text, exportedAt,
  fetchImpl = fetch, attempts = 4, backoffMs = 5000, sleep = sleepMs }) {
  if (!ingestSecret) throw new Error('Missing ingest secret');
  const url = workerEndpoint(workerUrl);
  const sanitizedSha256 = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  const body = JSON.stringify({ format: 'csv_text', text, weekStart, sanitizedSha256, exportedAt, sourceFormat: 'custom' });
  let last = { ok: false, httpStatus: null, error: 'not_attempted' };
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ingest-Secret': ingestSecret }, body });
      let j = null; try { j = await res.json(); } catch { /* not JSON */ }
      if (res.ok) {
        return { ok: true, httpStatus: res.status, attempts: i, sourceStatus: j?.sourceStatus || null, sourceHash: j?.sourceHash || null,
                 runId: j?.runId || null, rowsWritten: j?.rowsWritten ?? null, duplicates: j?.duplicates ?? null, sanitizedSha256 };
      }
      last = { ok: false, httpStatus: res.status, attempts: i, error: typeof j?.error === 'string' ? j.error.slice(0, 64) : `http_${res.status}`, sanitizedSha256 };
      if (!retryable(res.status)) return last;
    } catch (e) {
      last = { ok: false, httpStatus: null, attempts: i, error: 'network_error', sanitizedSha256 };
    }
    if (i < attempts) await sleep(backoffMs * 2 ** (i - 1));
  }
  return last;
}
