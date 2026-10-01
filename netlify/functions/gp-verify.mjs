/**
 * gp-verify — Netlify Function: independent verification of collector-computed weeks
 * ==================================================================================
 * POST /.netlify/functions/gp-verify   header X-Verify-Trigger: <SB_VERIFY_TRIGGER_SECRET>
 *   { snapshotId }      verify one collector-computed snapshot
 *   { snapshotIds }     verify up to 20 snapshots in one run (shared source cache)
 *   { sweep: true }     verify every snapshot the Worker lists as pending (bounded by time)
 * gp-verify-background (same logic, a Netlify background function, up to 15 minutes) is
 * what the collector calls after a Monday run: it answers 202 at once and writes each
 * report to the Worker; the collector then reads the week status.
 *
 * Netlify builds this function from the repository at the deployed commit — a
 * separate machine and code source from the office PC that computed the week.
 * It fetches the pinned inputs and the stored results from the Worker with the
 * narrow `verify` credential, recomputes with the unchanged shared engine
 * (shared/verify.js) and writes one report per snapshot to the Worker.
 *
 * Privacy (owner rule): the HTTP response and every log line carry status,
 * reason codes and COUNTS only (publicView). No customer data, order details
 * or field-level differences — those go only to the Worker's admin-only
 * verification store.
 *
 * Environment: SB_WORKER_ORIGIN (https://…), SB_VERIFY_SECRET (Worker verify
 * credential), SB_VERIFY_TRIGGER_SECRET (callers). No schedule is configured:
 * scheduled automation stays off until approved.
 */
import { webcrypto } from 'node:crypto';
import { verifySnapshot, publicView } from '../../shared/verify.js';

// The shared engine hashes with WebCrypto; older Lambda Node runtimes lack the global.
if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

const SNAP_RE = /^snp_[0-9a-f]{20}$/;
const SWEEP_BUDGET_MS = 45_000;
const enc = new TextEncoder();
function sameSecret(a, b) {
  const x = enc.encode(String(a || '')), y = enc.encode(String(b || ''));
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0 && x.length > 0;
}
const respond = (status, body, log) => { log(JSON.stringify({ evt: 'gp-verify', ...body })); return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }); };
const gunzip = async res => new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).text();

/** The Worker API as the verifier core expects it (verify credential; retried on 5xx and network errors). */
export function workerApi({ origin, secret, fetchImpl = fetch, snapshotId, attempts = 3 }) {
  const h = { 'X-Verify-Secret': secret, 'User-Agent': 'sb-gp-verify/1.0 (+netlify function)' };
  async function call(path, init = {}) {
    let last;
    for (let i = 0; i < attempts; i++) {
      try {
        const r = await fetchImpl(`${origin}${path}`, { ...init, headers: { ...h, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
        if (r.ok) return r;
        last = new Error(`worker_${r.status}`); last.code = `worker_${r.status}`;
        if (r.status < 500 && r.status !== 429) break;
      } catch { last = Object.assign(new Error('worker_unreachable'), { code: 'worker_unreachable' }); }
      await new Promise(res => setTimeout(res, 300 * (i + 1)));
    }
    throw last;
  }
  const post = (path, body) => call(path, { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
  return {
    inputs: () => call(`/v1/verify/snapshots/${snapshotId}`).then(r => r.json()),
    pending: () => call('/v1/verify/pending').then(r => r.json()),
    orderBodies: hashes => post('/v1/collect/order-bodies', { hashes }).then(j => j.bodies),
    scrDays: keys => post('/v1/collect/scr/days', { keys }).then(j => j.days),
    catalogPart: (rev, t, p) => call(`/v1/collect/catalog/${rev}/parts/${encodeURIComponent(t)}/${p}`).then(r => r.text()),
    aux: week => call(`/v1/collect/weeks/${week}/aux`).then(r => r.json()),
    resultPart: name => call(`/v1/verify/snapshots/${snapshotId}/parts/${name}`).then(gunzip),
    sourceMeta: id => call(`/v1/collect/sources/${id}`).then(r => r.json()),
    sourceSegment: (id, seq) => call(`/v1/collect/sources/${id}/segments/${seq}`).then(gunzip),
    report: (report, diff) => post(`/v1/verify/snapshots/${snapshotId}/report`, { report, diff }),
  };
}

export async function verifyOne({ env, snapshotId, fetchImpl, now = () => Date.now(), sourceCache = new Map() }) {
  const api = workerApi({ origin: env.SB_WORKER_ORIGIN, secret: env.SB_VERIFY_SECRET, fetchImpl, snapshotId });
  let result;
  try { result = await verifySnapshot(await api.inputs(), api, { now, sourceCache }); }
  catch (e) { result = { publicReport: { status: 'unavailable', reason: /^worker_\w+$/.test(e?.code || '') ? e.code : 'verify_failed' }, privateDiff: null }; }
  const pub = publicView(result.publicReport);
  try { await api.report(pub, result.privateDiff); }
  catch (e) { return { ...pub, recorded: false, recordError: /^worker_\w+$/.test(e?.code || '') ? e.code : 'report_failed' }; }
  return { ...pub, recorded: true };
}

/** Verify several snapshots in one run (shared source cache). Returns per-status counts only. */
export async function verifyMany({ env, snapshotIds, fetchImpl, budgetMs = Infinity }) {
  const t0 = Date.now(), sourceCache = new Map();
  const tally = { verified: 0, mismatch: 0, unavailable: 0, notRecorded: 0, skipped: 0 };
  for (const snapshotId of snapshotIds) {
    if (Date.now() - t0 > budgetMs) { tally.skipped++; continue; }
    const r = await verifyOne({ env, snapshotId, fetchImpl, sourceCache });
    tally[r.status] = (tally[r.status] || 0) + 1; if (!r.recorded) tally.notRecorded++;
  }
  return { checked: snapshotIds.length - tally.skipped, ...tally, totalMs: Date.now() - t0 };
}

export default async function handler(req, context = {}) {
  const env = context.env || globalThis.Netlify?.env?.toObject?.() || process.env;
  const log = context.log || console.log;
  const fetchImpl = context.fetchImpl || fetch;
  if (req.method !== 'POST') return respond(405, { status: 'refused', reason: 'method' }, log);
  if (!sameSecret(req.headers.get('x-verify-trigger'), env.SB_VERIFY_TRIGGER_SECRET)) return respond(401, { status: 'refused', reason: 'unauthorized' }, log);
  if (!/^https:\/\/[^/]+$/.test(env.SB_WORKER_ORIGIN || '') || !env.SB_VERIFY_SECRET) return respond(503, { status: 'refused', reason: 'not_configured' }, log);
  let body; try { body = await req.json(); } catch { return respond(400, { status: 'refused', reason: 'bad_payload' }, log); }
  const budgetMs = context.budgetMs ?? SWEEP_BUDGET_MS;
  if (body?.sweep === true) {
    const list = (await workerApi({ origin: env.SB_WORKER_ORIGIN, secret: env.SB_VERIFY_SECRET, fetchImpl }).pending().catch(() => ({ pending: [] }))).pending || [];
    return respond(200, { status: 'swept', ...(await verifyMany({ env, snapshotIds: list.map(p => p.snapshotId), fetchImpl, budgetMs })) }, log);
  }
  if (Array.isArray(body?.snapshotIds)) {
    if (!body.snapshotIds.length || body.snapshotIds.length > 20 || !body.snapshotIds.every(id => SNAP_RE.test(id))) return respond(400, { status: 'refused', reason: 'bad_payload' }, log);
    return respond(200, { status: 'batch', ...(await verifyMany({ env, snapshotIds: body.snapshotIds, fetchImpl, budgetMs })) }, log);
  }
  if (!SNAP_RE.test(body?.snapshotId || '')) return respond(400, { status: 'refused', reason: 'bad_payload' }, log);
  const t0 = Date.now();
  const r = await verifyOne({ env, snapshotId: body.snapshotId, fetchImpl });
  return respond(r.recorded ? 200 : 502, { ...r, totalMs: Date.now() - t0 }, log);
}
