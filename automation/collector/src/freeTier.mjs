/**
 * freeTier.mjs — the office PC's side of the Free-tier weekly path
 * ================================================================
 * The collector already exports and sanitizes on this PC (raw exports never
 * leave it). On the Free-tier path it then:
 *
 *   1. uploads each sanitized source in ≤ 100-row gzip segments the Worker
 *      validates before retaining anything (manifest → segments → seal);
 *   2. Shipping Cost Report: builds the per-(date, order) groups with the
 *      unchanged parser and submits the version; the Worker applies the
 *      owner-approved acceptance rules;
 *   3. Shopify: normalizes the orders, sends only new or changed ones
 *      (content-addressed, 10 per request);
 *   4. computes the new week and every week whose inputs changed, oldest first,
 *      with the unchanged shared engine from the Worker-pinned manifest, and
 *      uploads the result parts (the Worker stores; it never computes);
 *   5. asks the independent verifier (Netlify Function gp-verify) to recompute
 *      each new draft; until it reports `verified` the draft stays provisional.
 *
 * Every step is idempotent (hash-equal content writes nothing), so a retry or a
 * re-run after a crash is safe. Nothing here logs a value, a row, a secret or a
 * response body: only codes and counts.
 */
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { parseCSV } from '../../../shared/calculator.js';
import { toCsvText } from '../../../shared/adapters/shopifyCsv.js';
import { csvRowsToNormalizedOrders } from '../../../shared/adapters/legacy.js';
import { parseShippingCostReport } from '../../../shared/adapters/shippingCostReport.js';
import { weekStartOf } from '../../../shared/normalized.js';
import { orderBodyString, computeFromParts } from '../../../shared/bundle.js';
import { resultParts } from '../../../shared/resultParts.js';
import { versionDays, dayGroups, dayHash, SCR_SEGMENT_ROWS } from '../../../shared/scrDays.js';
import { ENGINE_VERSION } from '../../../shared/snapshot.js';
import { rollingWindow } from '../../shopify-export/src/lib.mjs';

export const SEGMENT_ROWS = SCR_SEGMENT_ROWS;          // Shopify segments use the same size (live-measured)
export const ORDERS_PER_REQUEST = 10;
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const gz = s => zlib.gzipSync(Buffer.from(s, 'utf8'), { level: 9 });
const sleepMs = ms => new Promise(r => setTimeout(r, ms));

/**
 * Worker answers that mean "the day's D1 allowance is (nearly) used up; resume after 00:00 UTC":
 * the Worker's background budget (background_deferred) and D1's own daily limit. Never retried soon.
 */
export const DEFERRAL_CODES = new Set(['background_deferred', 'd1_daily_limit_reached']);
export const isDeferral = e => e instanceof WorkerCallError && DEFERRAL_CODES.has(e.code);

export class WorkerCallError extends Error {
  constructor(status, code, detail) { super(code); this.status = status; this.code = code; this.detail = detail; }
}

/** HTTPS Worker client for /v1/collect/* (ingest credential). Retries network errors, 429 and 5xx. */
export function collectClient({ workerUrl, ingestSecret, fetchImpl = fetch, attempts = 4, backoffMs = 1500, sleep = sleepMs }) {
  let origin;
  try { const u = new URL(workerUrl); if (u.protocol !== 'https:') throw new Error(); origin = u.origin; } catch { throw new Error('workerUrl must be an https URL'); }
  if (!ingestSecret) throw new Error('Missing ingest secret');
  const stats = { requests: 0, retries: 0 };
  async function call(method, path, { json, bytes, raw = false } = {}) {
    if (!/^\/v1\/collect\/[\w:/.-]+(\?[\w=,&-]+)?$/.test(path)) throw new Error('unexpected collect path');
    const headers = { 'X-Ingest-Secret': ingestSecret, 'User-Agent': 'sb-gp-collector/1.0' };
    let body;
    if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    if (bytes !== undefined) { headers['Content-Type'] = 'application/gzip'; body = bytes; }
    let last;
    for (let i = 1; i <= attempts; i++) {
      stats.requests++;
      try {
        const res = await fetchImpl(`${origin}${path}`, { method, headers, body });
        if (res.ok) return raw ? res : res.json();
        let j = null; try { j = await res.json(); } catch { /* not JSON */ }
        last = new WorkerCallError(res.status, typeof j?.error === 'string' ? j.error.slice(0, 64) : `http_${res.status}`, j?.detail);
        // The day's D1 allowance (or the background budget) is used up: retrying only adds load. Stop now.
        if (DEFERRAL_CODES.has(last.code)) throw last;
        if (!(res.status === 429 || res.status >= 500)) throw last;
      } catch (e) {
        if (e instanceof WorkerCallError && (DEFERRAL_CODES.has(e.code) || !(e.status === 429 || e.status >= 500))) throw e;
        last = e instanceof WorkerCallError ? e : new WorkerCallError(null, 'network_error');
      }
      if (i < attempts) { stats.retries++; await sleep(backoffMs * i); }
    }
    throw last;
  }
  return { call, stats };
}

/** Sanitized CSV text → ≤ 100-row gzip segments with the header repeated. */
export function segmentCsv(text) {
  const rows = parseCSV(String(text).replace(/^\uFEFF/, ''));
  if (!rows.length) throw new Error('empty_source');
  const cols = Object.keys(rows[0]), out = [];
  for (let i = 0; i < rows.length; i += SEGMENT_ROWS) {
    const part = rows.slice(i, i + SEGMENT_ROWS), bytes = gz(toCsvText(part, cols));
    out.push({ bytes, sha256: sha(bytes), rows: part.length });
  }
  return { rows, segments: out };
}

export async function uploadSource(c, { kind, text, window, exportedAt, weekStart, cents }) {
  const { rows, segments } = segmentCsv(text);
  const listHash = sha(segments.map(s => s.sha256).join('\n'));
  const open = await c.call('POST', '/v1/collect/sources', { json: { kind, sha256: listHash, rows: rows.length, cents, window, exportedAt, weekStart,
    segments: segments.map(s => ({ sha256: s.sha256, rows: s.rows })) } });
  if (open.status === 'already_have') return { sourceId: open.sourceId, status: 'already_have', rows, uploaded: 0 };
  for (const seq of open.missing) await c.call('PUT', `/v1/collect/sources/${open.sourceId}/segments/${seq}`, { bytes: segments[seq].bytes });
  const seal = await c.call('POST', `/v1/collect/sources/${open.sourceId}/seal`, { json: {} });
  return { sourceId: open.sourceId, status: seal.status, rows, uploaded: open.missing.length, flags: seal.summary?.flags || {} };
}

/** payload = the existing sanitized Shipping Cost Report upload body (shippingCostUploadBody). */
export async function uploadShippingCostReport(c, payload) {
  const { requestedFrom: from, requestedTo: to, exportedAt } = payload;
  const parsed = parseShippingCostReport(parseCSV(payload.text.replace(/^\uFEFF/, '')), { requestedFrom: from, requestedTo: to });
  const src = await uploadSource(c, { kind: 'shipping_cost_report', text: payload.text, window: { from, to }, exportedAt, cents: parsed.shippingCostCents });
  const days = await versionDays(parsed.rows, from, to);
  // Dates identical to their current owner go as their hash alone: the Worker's work then grows with the changed dates.
  const owned = new Map((await c.call('POST', '/v1/collect/scr/owners', { json: { from, to } })).owners);
  const v = await c.call('POST', '/v1/collect/scr/versions', { json: { sourceId: src.sourceId, requestedFrom: from, requestedTo: to, exportedAt,
    days: days.map(d => (owned.get(d.date) === d.hash ? [d.date, null, d.hash] : [d.date, d.groups])) } });
  return { sourceId: src.sourceId, sourceStatus: src.status, versionId: v.versionId, status: v.status, reviewReasons: v.reviewReasons || [],
           counts: v.counts || {}, heldDates: v.heldDates || [], affectedWeeks: v.affectedWeeks || [],
           ...(v.automatic ? { automatic: true, flags: v.flags || [], changedDates: v.changedDates || [], omittedDates: v.omittedDates || [], dates: v.dates || {}, ...(v.invalidReasons ? { invalidReasons: v.invalidReasons } : {}) } : {}) };
}

/** payload = the existing sanitized Shopify rolling-export upload body. Returns the weeks whose orders changed. */
export async function uploadShopifyOrders(c, payload, { bodies = new Map() } = {}) {
  const src = await uploadSource(c, { kind: 'shopify', text: payload.text, window: { from: payload.windowFrom, to: payload.windowTo },
                                     exportedAt: payload.exportedAt, weekStart: payload.weekStart });
  const orders = csvRowsToNormalizedOrders(src.rows).map(o => { const s = orderBodyString(o); const h = sha(s); bodies.set(h, s); return { name: o.orderName, s, h }; });
  const weeksTouched = {}; let written = 0;
  for (let i = 0; i < orders.length; i += 1000) {
    const batch = orders.slice(i, i + 1000);
    const need = new Set((await c.call('POST', '/v1/collect/orders/diff', { json: { orders: batch.map(o => [o.name, o.h]) } })).needPointer);
    const send = batch.filter(o => need.has(o.name));
    for (let k = 0; k < send.length; k += ORDERS_PER_REQUEST) {
      const r = await c.call('POST', '/v1/collect/orders', { json: { sourceId: src.sourceId, orders: send.slice(k, k + ORDERS_PER_REQUEST).map(o => ({ s: o.s, h: o.h })) } });
      written += r.written;
      for (const [w, n] of Object.entries(r.weeksTouched || {})) weeksTouched[w] = (weeksTouched[w] || 0) + n;
    }
  }
  return { sourceId: src.sourceId, sourceStatus: src.status, orders: orders.length, written, weeksTouched, bodies };
}

/** Fetch every part a manifest names (local cache first), then compute with the unchanged engine. */
export async function computeFromManifest(c, manifest, cache) {
  const need = [...new Set(manifest.orders.map(o => o[1]))].filter(h => !cache.bodies.has(h));
  for (let i = 0; i < need.length; i += 200) for (const [h, b] of (await c.call('POST', '/v1/collect/order-bodies', { json: { hashes: need.slice(i, i + 200) } })).bodies) cache.bodies.set(h, b);
  const days = manifest.scrDays.filter(([, , h]) => !cache.days.has(h)).map(([d, v]) => [v, d]);
  for (let i = 0; i < days.length; i += 400) for (const [, , h, g] of (await c.call('POST', '/v1/collect/scr/days', { json: { keys: days.slice(i, i + 400) } })).days) cache.days.set(h, JSON.parse(g));
  const rev = manifest.catalog.rev;
  if (!cache.catalog.has(rev)) {
    const parts = [];
    for (const [t, p] of manifest.catalog.parts) parts.push([t, p, await (await c.call('GET', `/v1/collect/catalog/${rev}/parts/${encodeURIComponent(t)}/${p}`, { raw: true })).text()]);
    cache.catalog.set(rev, parts);
  }
  const aux = await c.call('GET', `/v1/collect/weeks/${manifest.weekStart}/aux`);
  return computeFromParts(manifest, { orderBodies: cache.bodies, dayGroups: cache.days, catalogParts: cache.catalog.get(rev), shipments: aux.shipments, hpdOrders: aux.hpdOrders });
}

export const newCache = (bodies = new Map()) => ({ bodies, days: new Map(), catalog: new Map() });

/**
 * One week: manifest → compute → results → finalize. A week the Worker is not
 * ready to compute (report pending review, no orders, …) is returned as
 * `{ status: 'pending', code }` — the exact reason, never a guess.
 */
export async function computeAndUploadWeek(c, weekStart, cache) {
  let m;
  // Pin the week's ShipStation/HPD hashes in their own request first (a no-op when nothing changed),
  // so the manifest request stays within the Workers Free CPU limit at peak week sizes.
  try { await c.call('POST', `/v1/collect/weeks/${weekStart}/aux-pin`, { json: {} }); }
  catch (e) { if (!(e instanceof WorkerCallError && e.status === 404)) throw e; }   // an older Worker without the route: the manifest hashes inline
  try { m = await c.call('GET', `/v1/collect/weeks/${weekStart}/manifest`); }
  catch (e) { if (e instanceof WorkerCallError && e.status === 409) return { weekStart, status: 'pending', code: e.code }; throw e; }
  if (m.existing) return { weekStart, status: 'unchanged', snapshotId: m.existing.snapshotId, revision: m.existing.revision, snapshotStatus: m.existing.status };
  const snap = await computeFromManifest(c, m.manifest, cache);
  const r = resultParts(snap, ENGINE_VERSION);
  const index = { engineVersion: ENGINE_VERSION, parts: Object.fromEntries(Object.entries(r.parts).map(([k, s]) => [k, sha(s)])),
                  orders: r.orderStrings.map(([n, s]) => [n, sha(s)]), head: r.head, totals: r.totals, narrative: r.narrative, gateInputs: r.gateInputs };
  const open = await c.call('POST', `/v1/collect/weeks/${weekStart}/results`, { json: { manifest: m.manifest, manifestHash: m.manifestHash, epoch: m.epoch, signature: m.signature, index } });
  for (const name of open.missing) await c.call('PUT', `/v1/collect/results/${open.snapshotId}/parts/${name}`, { bytes: gz(r.parts[name]) });
  // `inputs_moved`: something was written while the Worker finalized; the upload stays open and a
  // retry commits if this week's inputs are still the pinned ones (else `inputs_changed`).
  for (let attempt = 1; ; attempt++) {
    try {
      const f = await c.call('POST', `/v1/collect/results/${open.snapshotId}/finalize`, { json: {} });
      return { weekStart, status: 'computed', snapshotId: f.snapshotId, revision: f.revision, snapshotStatus: f.status, orders: snap.orders.length };
    } catch (e) {
      if (e instanceof WorkerCallError && e.code === 'inputs_changed') return { weekStart, status: 'pending', code: 'inputs_changed' };
      if (e instanceof WorkerCallError && e.code === 'inputs_moved' && attempt < 4) continue;
      if (e instanceof WorkerCallError && e.code === 'inputs_moved') return { weekStart, status: 'pending', code: 'inputs_moved' };
      throw e;
    }
  }
}

/**
 * Ask the verifier (gp-verify-background: answers 202, runs up to 15 minutes) to recompute
 * the new drafts in one run, then read each week's status from the Worker until every
 * draft has a report or `waitMs` passes. Returns the verification status per snapshot;
 * one still running is reported as `verification_pending` — never as verified.
 */
export async function requestVerification({ verifyUrl, triggerSecret, snapshots, client, fetchImpl = fetch, waitMs = 8 * 60_000, pollMs = 15_000, sleep = sleepMs, now = () => Date.now() }) {
  if (!snapshots.length) return [];
  let accepted = true;
  // The verifier takes at most 20 snapshots per request.
  for (let i = 0; i < snapshots.length && accepted; i += 20) {
    try {
      const res = await fetchImpl(verifyUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Verify-Trigger': triggerSecret },
        body: JSON.stringify({ snapshotIds: snapshots.slice(i, i + 20).map(s => s.snapshotId) }) });
      accepted = res.status === 202 || res.ok;
    } catch { accepted = false; }
  }
  if (!accepted) return snapshots.map(s => ({ snapshotId: s.snapshotId, status: 'verifier_unreachable' }));
  const out = new Map(), t0 = now();
  let batched = true;                       // GET /v1/collect/verification: one light request per poll (404/400 → per-week status)
  for (;;) {
    if (batched) {
      const pending = snapshots.filter(s => !out.has(s.snapshotId));
      try {
        for (const [id, x] of await verificationOf(client, pending.map(s => s.snapshotId))) {
          if (x.superseded) out.set(id, 'superseded');
          else if (x.verification) out.set(id, x.verification);
        }
      } catch (e) { if (!(e instanceof WorkerCallError) || e.status === 404 || e.status === 400) batched = false; }   // older Worker or refused: per-week status
    }
    if (!batched) for (const s of snapshots) {
      if (out.has(s.snapshotId)) continue;
      const st = await client.call('GET', `/v1/collect/weeks/${s.weekStart}/status`).catch(() => null);
      if (st?.draft?.snapshotId === s.snapshotId && st.verification) out.set(s.snapshotId, st.verification.status);
      else if (st?.draft && st.draft.snapshotId !== s.snapshotId) out.set(s.snapshotId, 'superseded');
    }
    if (out.size === snapshots.length || now() - t0 >= waitMs) break;
    await sleep(pollMs);
  }
  return snapshots.map(s => ({ snapshotId: s.snapshotId, status: out.get(s.snapshotId) || 'verification_pending' }));
}

/** Verification state of snapshots (GET /v1/collect/verification, ≤ 16 ids per request): Map id → { verification, superseded }. */
export async function verificationOf(client, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 16) {
    const r = await client.call('GET', `/v1/collect/verification?ids=${ids.slice(i, i + 16).join(',')}`);
    for (const x of r.snapshots || []) out.set(x.snapshotId, { verification: x.verification || null, superseded: !!x.superseded });
  }
  return out;
}
/**
 * Every page of GET /v1/collect/verification/pending (oldest week first), up to `maxPages`.
 * → { status: 'ok' | 'unsupported' | 'failed' | 'truncated', pending, otherEngine }.
 * 'unsupported' only for an explicit 404 from an older Worker without the route; any other error
 * (network, quota, 5xx, refused) is 'failed' — never read as an empty backlog.
 */
export async function drainPendingVerifications(client, { pageSize = 50, maxPages = 10 } = {}) {
  const pending = [];
  let after = null, otherEngine = 0;
  for (let page = 0; page < maxPages; page++) {
    let r;
    try { r = await client.call('GET', `/v1/collect/verification/pending?limit=${pageSize}${after ? `&after=${after}` : ''}`); }
    catch (e) {
      if (e instanceof WorkerCallError && e.status === 404 && !pending.length) return { status: 'unsupported', pending: [], otherEngine: 0 };
      return { status: 'failed', code: e instanceof WorkerCallError ? e.code : 'network_error', pending, otherEngine };
    }
    pending.push(...(r.pending || []));
    otherEngine += Number(r.otherEngine) || 0;
    // A Worker before paging answers one list without `next`: that list is all it has.
    if (!r.next) return { status: 'ok', pending, otherEngine };
    after = r.next;
  }
  return { status: 'truncated', pending, otherEngine };
}

/**
 * Every page of GET /v1/collect/publication/pending: weeks whose newest revision is a verified,
 * unpublished draft (eligible weeks only) or a published revision with a stale comparison.
 * Same contract as drainPendingVerifications: only an explicit 404 is 'unsupported'.
 */
export async function drainPublicationBacklog(client, { pageSize = 50, maxPages = 4 } = {}) {
  const weeks = [];
  let after = null;
  for (let page = 0; page < maxPages; page++) {
    let r;
    try { r = await client.call('GET', `/v1/collect/publication/pending?limit=${pageSize}${after ? `&after=${after}` : ''}`); }
    catch (e) {
      if (e instanceof WorkerCallError && e.status === 404 && !weeks.length) return { status: 'unsupported', weeks: [] };
      return { status: 'failed', code: e instanceof WorkerCallError ? e.code : 'network_error', weeks };
    }
    weeks.push(...(r.weeks || []));
    if (!r.next) return { status: 'ok', weeks };
    after = r.next;
  }
  return { status: 'truncated', weeks };
}

/**
 * Every page of GET /v1/collect/corrections/pending: weeks an audited cost correction covers whose newest
 * revision predates it. Same contract as the other backlogs: only an explicit 404 is 'unsupported'.
 */
export async function drainCorrections(client, { pageSize = 50, maxPages = 2 } = {}) {
  const weeks = [];
  let after = null;
  for (let page = 0; page < maxPages; page++) {
    let r;
    try { r = await client.call('GET', `/v1/collect/corrections/pending?limit=${pageSize}${after ? `&after=${after}` : ''}`); }
    catch (e) {
      if (e instanceof WorkerCallError && e.status === 404 && !weeks.length) return { status: 'unsupported', weeks: [] };
      return { status: 'failed', code: e instanceof WorkerCallError ? e.code : 'network_error', weeks };
    }
    weeks.push(...(r.weeks || []));
    if (!r.next) return { status: 'ok', weeks };
    after = r.next;
  }
  return { status: 'truncated', weeks };
}

/** Verified, or a finished verification that found differences (not retryable by verifying again). */
const VERIFICATION_FINISHED = new Set(['verified', 'mismatch']);

/**
 * Weeks to check, oldest first: every week of the rolling window up to the closed week, plus
 * any earlier week whose inputs this run touched. Each check is one manifest request; a week
 * whose newest revision already has exactly these inputs is skipped (0 rows written).
 */
export function weeksToCompute({ closedWeek, windowFrom, touched = [] }) {
  const out = new Set(touched.filter(w => w <= closedWeek));
  for (let w = weekStartOf(windowFrom); w <= closedWeek; w = addDaysLocal(w, 7)) out.add(w);
  return [...out].sort();
}


/**
 * Publication refusals that are intentional holds: the Worker refused by policy or configuration
 * (a switch off, a week not eligible, a gate that fails on the week's data). Retrying within the
 * hour cannot change them, so they do not make the run partial. Every other refusal or failure
 * (network, Worker error, verification not finished, a comparison or report basis that moved, a
 * concurrent change) is retryable: the run reports `partial`, the Windows task does not mark the
 * week done, and its next attempt offers the week again.
 */
export const PUBLICATION_HOLDS = Object.freeze(['publication_disabled', 'publication_not_allowed_in_environment', 'carrier_fee_priority_unlocked',
  'store_timezone_unconfirmed', 'store_timezone_changed', 'costs_not_period_accurate', 'gate_failed', 'shipping_source_unverified',
  'publish_route_unavailable', 'no_snapshot']);
/** Holds that apply to every week alike: the remaining weeks are not offered. */
const GLOBAL_HOLDS = new Set(['publication_disabled', 'publication_not_allowed_in_environment', 'carrier_fee_priority_unlocked',
  'store_timezone_unconfirmed', 'publish_route_unavailable']);
export const publicationOutcome = p => (p.published ? (p.alreadyPublished ? 'already_published' : 'published')
  : PUBLICATION_HOLDS.includes(p.reason) ? 'held' : 'retry');

/**
 * Wiring for run.mjs: an upload function the two collectors call in place of the
 * csv_text routes, and the compute step the orchestrator runs after them.
 * Returns codes and counts only.
 */
export function freeTierPipeline({ workerUrl, ingestSecret, verifyUrl = null, triggerSecret = null, closedWeek, fetchImpl = fetch, sleep, verifyWaitMs,
                                   maxRefreshesPerRun = 12, maxCorrectionWeeksPerRun = 12 }) {
  const base = collectClient({ workerUrl, ingestSecret, fetchImpl, ...(sleep ? { sleep } : {}) });
  // The first deferral answer of this run (quota): every later step stops, and the run reports 'deferred'.
  let deferredBy = null;
  const c = { stats: base.stats, async call(...a) { try { return await base.call(...a); } catch (e) { if (isDeferral(e)) deferredBy ??= e; throw e; } } };
  const seen = { touched: new Set(), windowFrom: null, bodies: new Map() };
  async function uploadImpl({ path, payload }) {
    try {
      if (path === '/v1/ingest/shipping-cost-report') {
        const r = await uploadShippingCostReport(c, payload);
        for (const w of r.affectedWeeks) seen.touched.add(w);
        return { ok: true, httpStatus: 200, attempts: 1, status: r.status, versionId: r.versionId, sourceStatus: r.sourceStatus,
                 reviewReasons: r.reviewReasons, heldDates: r.heldDates.length, sanitizedSha256: payload.sanitizedSha256 || null,
                 ...(r.automatic ? { flags: r.flags, changedDates: r.changedDates.length, ...(r.invalidReasons ? { invalidReasons: r.invalidReasons } : {}) } : {}) };
      }
      if (path === '/v1/ingest/shopify') {
        const r = await uploadShopifyOrders(c, payload, { bodies: seen.bodies });
        for (const w of Object.keys(r.weeksTouched)) seen.touched.add(w);
        seen.windowFrom = payload.windowFrom || seen.windowFrom;
        return { ok: true, httpStatus: 200, attempts: 1, status: 'ok', sourceStatus: r.sourceStatus, rowsWritten: r.written,
                 duplicates: r.orders - r.written, sanitizedSha256: payload.sanitizedSha256 || null };
      }
      if (path === '/v1/collect/aps-map') {
        // Air Plant Shop scenario input: stored apart from results; never touches a week's inputs or revisions.
        const r = await c.call('POST', '/v1/collect/aps-map', { json: payload });
        return { ok: true, httpStatus: 200, attempts: 1, status: 'ok', sourceStatus: r.sourceStatus, versionId: r.versionId, orders: r.orders };
      }
      return { ok: false, httpStatus: null, error: 'unsupported_path' };
    } catch (e) {
      return { ok: false, httpStatus: e?.status ?? null, error: typeof e?.code === 'string' ? e.code.slice(0, 64) : 'upload_failed' };
    }
  }
  /**
   * The Worker's background budget for today. → { state: 'ok' | 'defer' | 'unknown', resetAt?, reasons? }.
   * Unreadable (unreachable Worker, error, a Worker without the route) is 'unknown', and 'unknown' starts
   * no background work: it is never read as "within budget".
   */
  async function budget() {
    try { const b = await c.call('GET', '/v1/collect/budget'); return { state: b.state === 'defer' ? 'defer' : 'ok', resetAt: b.resetAt, reasons: b.reasons || [], fractions: b.fractions }; }
    catch (e) {
      if (isDeferral(e)) return { state: 'defer', resetAt: e.detail?.resetAt || null, reasons: [e.code] };
      return { state: 'unknown', code: e instanceof WorkerCallError ? e.code : 'network_error' };
    }
  }
  /** GET /v1/collect/work: { unfinished: [codes], budget: { state, reasons, resetAt } } for the closed week. */
  async function work() { return c.call('GET', `/v1/collect/work?week=${closedWeek}`); }
  const deferredResult = extra => ({ status: 'deferred', code: deferredBy?.code || 'background_deferred', resumeAfter: deferredBy?.detail?.resetAt || null,
                                     requests: c.stats.requests, retries: c.stats.retries, ...extra });
  async function compute() {
    deferredBy = null;
    const b = await budget();
    // Fail closed: when the day's usage cannot be read, no background work starts (bounded retries follow).
    if (b.state === 'unknown') return { status: 'partial', code: 'budget_unavailable', weeks: [], publication: [], requests: c.stats.requests, retries: c.stats.retries };
    if (b.state === 'defer') { deferredBy ??= new WorkerCallError(503, 'background_deferred', { resetAt: b.resetAt, reasons: b.reasons }); return deferredResult({ weeks: [], publication: [], reasons: b.reasons }); }
    const out = await computeRun();
    // A deferral anywhere in the run (the Worker's budget gate or D1's own limit): nothing more was attempted,
    // and the run is never reported ok or complete.
    return deferredBy ? deferredResult({ weeks: out.weeks, publication: out.publication }) : out;
  }
  async function computeRun() {
    const windowFrom = seen.windowFrom || rollingWindow({ weekStart: closedWeek, weekEnd: addDaysLocal(closedWeek, 6) }).from;
    // Weeks an audited cost correction covers that still need their corrected revision, whatever the window
    // (oldest first, at most maxCorrectionWeeksPerRun per run; what is left keeps the run partial).
    const corrections = await drainCorrections(c);
    const correctionWeeks = corrections.weeks.map(x => x.weekStart).filter(w => w <= closedWeek);
    const capped = correctionWeeks.slice(0, maxCorrectionWeeksPerRun);
    const weeks = [...new Set([...weeksToCompute({ closedWeek, windowFrom, touched: [...seen.touched] }), ...capped])].sort();
    const cache = newCache(seen.bodies), results = [];
    for (const w of weeks) {
      if (deferredBy) break;
      try { results.push(await computeAndUploadWeek(c, w, cache)); }
      catch (e) { results.push({ weekStart: w, status: 'failed', code: typeof e?.code === 'string' ? e.code.slice(0, 64) : 'compute_failed' }); }
    }
    const fresh = results.filter(r => r.status === 'computed');
    // Unfinished verification is recovered on every run: the newest revision of an unchanged week that
    // has no finished verification (a run stopped mid-way, the verifier was unreachable), and the newest
    // unverified revision of any other week the Worker lists, are requested again with this run's drafts.
    const unchanged = results.filter(r => r.status === 'unchanged' && r.snapshotId);
    let known = new Map(), recover = [], lookupFailed = false;
    try { known = await verificationOf(c, unchanged.map(r => r.snapshotId)); } catch { lookupFailed = unchanged.length > 0; }
    for (const r of unchanged) {
      const x = known.get(r.snapshotId);
      if (lookupFailed) r.verification = 'verification_unknown';
      else if (x && !x.superseded) { r.verification = x.verification || 'verification_pending'; if (!VERIFICATION_FINISHED.has(x.verification)) recover.push(r); }
    }
    const inRun = new Set(results.map(r => r.weekStart));
    // The Worker's backlog of unverified newest drafts, every page. Only an explicit "route unsupported"
    // (older Worker) falls back to this run's weeks; a lookup that failed keeps the run partial.
    if (deferredBy) return { status: 'deferred', weeks: results, publication: [] };
    const backlog = await drainPendingVerifications(c);
    const elsewhere = backlog.pending.filter(p => !inRun.has(p.weekStart));
    const toVerify = [...fresh, ...recover, ...elsewhere.map(p => ({ weekStart: p.weekStart, snapshotId: p.snapshotId, revision: p.revision, status: 'unchanged' }))];
    const verification = verifyUrl && triggerSecret ? await requestVerification({ verifyUrl, triggerSecret, snapshots: toVerify, client: c, fetchImpl, ...(verifyWaitMs !== undefined ? { waitMs: verifyWaitMs } : {}), ...(sleep ? { sleep } : {}) })
      : toVerify.map(r => ({ snapshotId: r.snapshotId, status: 'not_requested' }));
    const byId = new Map(verification.map(v => [v.snapshotId, v.status]));
    const weeksOut = results.map(r => ({ weekStart: r.weekStart, status: r.status, ...(r.code ? { code: r.code } : {}), ...(r.revision ? { revision: r.revision } : {}),
                                          ...(byId.has(r.snapshotId) ? { verification: byId.get(r.snapshotId) } : r.verification ? { verification: r.verification } : {}),
                                          ...(recover.includes(r) ? { verificationRecovered: true } : {}) }));
    const otherWeeks = elsewhere.map(p => ({ weekStart: p.weekStart, revision: p.revision, verification: byId.get(p.snapshotId) || 'verification_pending' }));
    // Automatic publication (owner decision 2026-10-05), oldest week first: the Worker publishes a week's
    // newest verified revision only when every control allows it, and answers with the reason otherwise.
    // Comparisons are brought up to date in the same run: a week whose stored comparison is not with the
    // prior week's published snapshot (a draft computed before that week was published, or a published
    // week whose prior week has since published a new revision) is recomputed from the cached and stored
    // inputs (no new export), verified and offered again. Each newly published revision then offers the
    // next week too, even outside the window, so a chain of dependent weeks finishes in one run.
    const publication = [];
    const publish = w => c.call('POST', `/v1/collect/weeks/${w}/publish`, { json: {} }).catch(e => ({ published: false, reason: e?.status === 404 ? 'publish_route_unavailable' : e?.code || 'publish_failed' }));
    const verifyOne = async snap => {
      if (!(verifyUrl && triggerSecret)) return 'not_requested';
      const [v] = await requestVerification({ verifyUrl, triggerSecret, snapshots: [snap], client: c, fetchImpl, ...(verifyWaitMs !== undefined ? { waitMs: verifyWaitMs } : {}), ...(sleep ? { sleep } : {}) });
      return v?.status || 'verification_pending';
    };
    const inWindow = new Map(weeksOut.map(r => [r.weekStart, r]));
    const offered = r => r.verification === 'verified' || (r.status === 'unchanged' && r.verification === undefined);
    // Publication work left by earlier runs, whatever their window (a dependent comparison that could not be
    // updated, a verified draft whose publication failed): resumed here, oldest first, from retained inputs.
    const pubBacklog = await drainPublicationBacklog(c);
    const resumed = new Set(pubBacklog.weeks.map(x => x.weekStart).filter(w => !inWindow.has(w)));
    const queue = [...new Set([...weeksOut.filter(offered).map(r => r.weekStart), ...otherWeeks.filter(o => o.verification === 'verified').map(o => o.weekStart),
                               ...resumed])].sort();
    const done = new Set(), dependents = [];
    let refreshes = 0;
    while (queue.length && !deferredBy) {
      const w = queue.shift();
      if (done.has(w)) continue;
      done.add(w);
      const r = inWindow.get(w) || null, dependent = !r && !otherWeeks.some(o => o.weekStart === w) && !resumed.has(w);
      let p = await publish(w), refreshed = null;
      // A per-run cap on recomputes for comparisons: what is left stays listed by the Worker and is resumed
      // by the next attempt (the run is partial), so one run cannot spend the day's allowance on a long chain.
      if (!p.published && p.reason === 'comparison_stale' && refreshes >= maxRefreshesPerRun) p = { published: false, reason: 'run_work_cap' };
      if (!p.published && p.reason === 'comparison_stale') {
        refreshes++;
        const again = await computeAndUploadWeek(c, w, cache).catch(() => null);
        let v = null;
        if (again?.status === 'computed') v = await verifyOne(again);
        else if (again?.status === 'unchanged') {       // a draft with the current comparison already exists
          const x = (await verificationOf(c, [again.snapshotId]).catch(() => new Map())).get(again.snapshotId);
          v = VERIFICATION_FINISHED.has(x?.verification) ? x.verification : await verifyOne(again);
        }
        refreshed = { revision: again?.revision ?? null, verification: v || (again?.status === 'pending' ? again.code : 'recompute_failed') };
        if (r) { if (again?.status === 'computed') { r.revision = again.revision; r.status = 'computed'; } r.verification = refreshed.verification; }
        if (v === 'verified') p = await publish(w);
        else if (!VERIFICATION_FINISHED.has(v)) p = { published: false, reason: 'comparison_stale' };   // unfinished: retried
        else p = { published: false, reason: `verification_${v}` };
      }
      // A week outside the run is skipped only when it is confirmed to need nothing: it has no snapshot, or its
      // newest revision is published with a current comparison. Anything else is recorded; a retryable outcome
      // keeps the run partial and the Worker lists the week again on the next run (publication backlog).
      const nothingToDo = !refreshed && (p.reason === 'no_snapshot' || (p.published === true && p.alreadyPublished === true));
      if ((dependent || resumed.has(w)) && nothingToDo) continue;
      if (dependent || resumed.has(w)) dependents.push({ weekStart: w, ...(resumed.has(w) ? { resumed: true } : {}),
        ...(refreshed ? { revision: refreshed.revision, verification: refreshed.verification } : {}) });
      const outcome = publicationOutcome({ ...p, reason: p.reason || 'publish_failed' });
      publication.push({ weekStart: w, published: p.published === true, outcome, ...(p.alreadyPublished && p.published ? { alreadyPublished: true } : {}),
                         ...(refreshed ? { comparisonRefreshed: true } : {}), ...(dependent ? { dependent: true } : {}), ...(resumed.has(w) ? { resumed: true } : {}),
                         ...(p.published ? {} : { reason: p.reason || 'publish_failed' }) });
      // Switched off for every week: stop asking.
      if (!p.published && GLOBAL_HOLDS.has(p.reason)) break;
      // A newly published revision changes the next week's comparison: offer that week in this run.
      if (p.published && !p.alreadyPublished) { const next = addDaysLocal(w, 7); if (!done.has(next) && !queue.includes(next)) { queue.push(next); queue.sort(); } }
    }
    const closed = weeksOut.find(r => r.weekStart === closedWeek);
    // A week before the reporting start is not a failure: it is not reported.
    // Unfinished verification (pending, unavailable, unreachable, unknown) keeps the run partial, for this run's
    // weeks and for the other weeks recovered; a finished `mismatch` of an unchanged week is reported, not retried.
    const finished = r => r.verification === undefined || VERIFICATION_FINISHED.has(r.verification);
    const good = weeksOut.every(r => r.code === 'before_reporting_start' || (r.status === 'unchanged' && finished(r)) || (r.status === 'computed' && r.verification === 'verified'))
      && otherWeeks.every(finished) && (backlog.status === 'ok' || backlog.status === 'unsupported')
      && (pubBacklog.status === 'ok' || pubBacklog.status === 'unsupported')
      && (corrections.status === 'ok' || corrections.status === 'unsupported') && capped.length === correctionWeeks.length;
    // A retryable publication failure keeps the run partial, so the week is retried; intentional holds do not.
    const publishRetry = publication.filter(p => p.outcome === 'retry').length;
    return { status: good && !publishRetry ? 'ok' : 'partial', closedWeek: closed || null, weeks: weeksOut, ...(otherWeeks.length ? { otherWeeks } : {}),
             ...(dependents.length ? { dependentWeeks: dependents } : {}),
             ...(backlog.status === 'ok' ? {} : { verificationBacklog: { status: backlog.status, ...(backlog.code ? { code: backlog.code } : {}) } }),
             ...(pubBacklog.status === 'ok' ? {} : { publicationBacklog: { status: pubBacklog.status, ...(pubBacklog.code ? { code: pubBacklog.code } : {}) } }),
             ...(correctionWeeks.length ? { correctedWeeks: capped, ...(capped.length < correctionWeeks.length ? { correctionWeeksLeft: correctionWeeks.length - capped.length } : {}) } : {}),
             ...(corrections.status === 'ok' ? {} : { correctionBacklog: { status: corrections.status, ...(corrections.code ? { code: corrections.code } : {}) } }),
             ...(backlog.otherEngine ? { otherEngineDrafts: backlog.otherEngine } : {}), publication,
             ...(publishRetry ? { publicationRetry: publishRetry } : {}), requests: c.stats.requests, retries: c.stats.retries };
  }
  /** The orchestrator's week plan on this path: what the Worker already holds for the closed week. */
  async function weekPlan() {
    const s = await c.call('GET', `/v1/collect/weeks/${closedWeek}/status`);
    const pending = new Set((s.pending || []).map(p => p.code));
    const shopify = pending.has('shopify_export_pending') ? 'missing' : 'ok';
    // A report that failed the automated checks is re-exported on the next attempt, like a missing one.
    const report = ['shipping_report_missing', 'shipping_report_partial', 'shipping_report_invalid'].some(k => pending.has(k)) ? 'missing' : 'ok';
    return { weekStart: closedWeek, collected: { shopify, shopify_updates: shopify, shipping_cost_report: report }, status: s.state };
  }
  /** Shopify's sign-in needs a person (or was finished): shown on the closed week's status. Codes and numbers only. */
  async function signInEvent(status, { authState, waitMinutes } = {}) {
    await c.call('POST', `/v1/collect/weeks/${closedWeek}/signin`, { json: { status, ...(authState ? { authState } : {}), ...(Number.isInteger(waitMinutes) ? { waitMinutes } : {}) } });
  }
  /** Which ship dates the Air Plant Shop mapping covers (the collector's backfill window). null when unreachable. */
  async function apsCoverage() {
    try { return await c.call('GET', '/v1/collect/aps-map/coverage'); } catch { return null; }
  }
  return { uploadImpl, compute, weekPlan, signInEvent, budget, work, apsCoverage, scrRowsFor: pairs => scrRowsResolver(c, pairs), client: c };
}

const OWNER_SPAN_DAYS = 60;                                  // well inside the owners route's date limit
/**
 * The exact Shipping Cost Report rows behind given [date, orderKey] pairs (APS split dates holding both kinds of
 * label): the version that owns each date now (or, for a cost the date kept from an earlier report, that cost's
 * source version), read from its retained source and parsed exactly as the verifier does. A date whose rows do not
 * rebuild the owner's stored day hash is not used. Returns rowsFor(date, orderKey) → { versionId, rows } | null.
 */
export async function scrRowsResolver(c, pairs) {
  const dates = [...new Set(pairs.map(p => p[0]))].sort();
  if (!dates.length) return () => null;
  const detail = new Map(), versions = new Map();
  for (let from = dates[0]; from <= dates[dates.length - 1];) {
    const to = [...dates].reverse().find(d => d <= addDaysIso(from, OWNER_SPAN_DAYS - 1));
    const r = await c.call('POST', '/v1/collect/scr/owners', { json: { from, to, detail: true } });
    if (!Array.isArray(r.detail)) return () => null;                         // an older Worker: no version detail
    for (const x of r.detail) detail.set(x[0], { versionId: x[1], dayHash: x[2], kept: new Map((x[3] || []).map(([k, v]) => [k, v])) });
    for (const v of r.versions || []) versions.set(v[0], { sourceId: v[1], from: v[2], to: v[3] });
    from = dates.find(d => d > to) || '9999-12-31';
  }
  const parsed = new Map();                                                  // versionId → parser rows (sources are immutable)
  const rowsOf = async vid => {
    if (parsed.has(vid)) return parsed.get(vid);
    const v = versions.get(vid);
    let rows = null;
    if (v) {
      try {
        const meta = await c.call('GET', `/v1/collect/sources/${v.sourceId}`);
        const csv = [];
        // Retained segments are served gzip-compressed (application/gzip), as the verifier reads them.
        for (let i = 0; i < (meta.segments || []).length; i++) {
          const res = await c.call('GET', `/v1/collect/sources/${v.sourceId}/segments/${i}`, { raw: true });
          csv.push(...parseCSV(zlib.gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8').replace(/^\uFEFF/, '')));
        }
        rows = parseShippingCostReport(csv, { requestedFrom: v.from, requestedTo: v.to }).rows;
      } catch { rows = null; }
    }
    parsed.set(vid, rows);
    return rows;
  };
  // The stored groups of the owned days (what a snapshot pins): the order's rows must add up to its group exactly.
  const stored = new Map();
  const ownedKeys = [...new Set(pairs.map(p => p[0]))].filter(d => detail.has(d)).map(d => [detail.get(d).versionId, d]);
  for (let i = 0; i < ownedKeys.length; i += 400) {
    for (const [, d, h, g] of (await c.call('POST', '/v1/collect/scr/days', { json: { keys: ownedKeys.slice(i, i + 400) } })).days || []) {
      if (detail.get(d)?.dayHash === h) stored.set(d, new Map(JSON.parse(g).map(x => [x[0], x])));
    }
  }
  const out = new Map();
  for (const [date, key] of pairs) {
    const d = detail.get(date);
    if (!d || !stored.has(date)) continue;
    const kept = d.kept.get(key);
    const vid = kept || d.versionId;
    const rows = await rowsOf(vid);
    if (!rows) continue;
    const mine = rows.filter(r => r.shipDate === date && r.orderKey === key);
    const g = stored.get(date).get(key);
    if (!g || g[1] !== mine.reduce((t, r) => t + r.shippingCostCents, 0) || g[2] !== mine.length) continue;
    if (!kept && !d.kept.size) {
      // A date with nothing kept: the owner's own rows must rebuild exactly the stored day.
      const groups = dayGroups(rows.filter(r => r.shipDate === date)).get(date) || [];
      if (await dayHash(date, groups) !== d.dayHash) continue;
    }
    out.set(`${date}|${key}`, { versionId: vid, rows: mine.map(r => ({ service: r.service, cents: r.shippingCostCents })) });
  }
  return (date, key) => out.get(`${date}|${key}`) || null;
}
const addDaysIso = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
function addDaysLocal(d, n) { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
