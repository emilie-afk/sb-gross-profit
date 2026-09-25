/**
 * catalogFetch.js — the Worker fetches, validates and versions the cost catalog (C6)
 * ==================================================================================
 * POST /v1/admin/catalog/fetch  { weekStart }            register a refresh and answer it
 *                               { refreshId }            answer one existing pending refresh
 *
 * Sources come from the CATALOG_SOURCES_JSON secret: a JSON object keyed by the
 * build.py environment variable names (MCG_SHEET_URL, …, HP_COSTS_FOLDER_ID,
 * GDRIVE_API_KEY, PRODUCT_COSTS_JSON1/2, SKU_WEIGHTS_JSON). No Netlify build and
 * no build hook are involved.
 *
 * Privacy of the sheet URLs:
 *   • a URL or key is never logged, returned, stored or put in an error;
 *   • provenance records the source NAME, a short SHA-256 of the URL, the byte
 *     count and a SHA-256 of the content, so a version can be pinned and audited;
 *   • fetch failures are reduced to fixed codes (http_403, html_response, …).
 *
 * Strict by design: if any configured source fails, nothing is imported and the
 * refresh is rejected. A catalog that is empty or shrank is saved as `rejected`
 * by validateCatalog() and never replaces the accepted one.
 */
import { ApiError, json, readJson } from './http.js';
import { newId, nowIso, getSettings } from './db.js';
import { saveCatalog, latestAcceptedCatalogMeta, loadCatalog, saveBaseCatalog } from './store.js';
import { withRun, resolveRefresh, REFRESH_ID_RE } from './ingest.js';
import { actorFor } from './actor.js';
import { mondayOrThrow } from './admin.js';
import { validateCatalog, catalogRevOf } from '../../shared/catalog.js';
import { buildCatalogTables, parseLivelyRootTab, URL_SOURCES, JSON_SOURCES, DRIVE_SOURCES } from '../../shared/catalogBuild.js';
import { OVERLAY_SOURCES, overlayVendorTabs, catalogCompleteness, validateBaseCatalog } from '../../shared/catalogOverlay.js';
import { pyCsvRows } from '../../shared/pyCompat.js';

export const ALLOWED_SOURCE_HOSTS = Object.freeze(['docs.google.com', 'drive.google.com', 'sheets.googleapis.com', 'www.googleapis.com']);
export const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 20_000;
const KNOWN = new Set([...URL_SOURCES, ...JSON_SOURCES, ...DRIVE_SOURCES]);

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', typeof s === 'string' ? new TextEncoder().encode(s) : s));
const short = async s => (await sha256(s)).slice(0, 16);

class SourceError extends Error { constructor(code) { super(code); this.code = code; } }

/** Parse and check the secret. Error messages name keys only, never values. */
export function parseSources(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new ApiError(409, 'catalog_sources_unconfigured', 'CATALOG_SOURCES_JSON is not set');
  let v;
  try { v = JSON.parse(raw); } catch { throw new ApiError(500, 'catalog_sources_invalid', 'CATALOG_SOURCES_JSON is not valid JSON'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ApiError(500, 'catalog_sources_invalid', 'CATALOG_SOURCES_JSON must be an object');
  const unknown = Object.keys(v).filter(k => !KNOWN.has(k));
  if (unknown.length) throw new ApiError(500, 'catalog_sources_invalid', `Unknown source names: ${unknown.slice(0, 5).join(', ')}`);
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (val === null || val === '') continue;                                  // unset, as in build.py
    if (typeof val !== 'string') throw new ApiError(500, 'catalog_sources_invalid', `${k} must be a string`);
    if (URL_SOURCES.includes(k)) {
      let u; try { u = new URL(val.trim()); } catch { throw new ApiError(500, 'catalog_sources_invalid', `${k} is not a URL`); }
      if (u.protocol !== 'https:' || !ALLOWED_SOURCE_HOSTS.includes(u.hostname)) throw new ApiError(500, 'catalog_sources_invalid', `${k} must be an https Google Sheets or Drive URL`);
    }
    if (JSON_SOURCES.includes(k)) { try { const j = JSON.parse(val); if (!j || typeof j !== 'object' || Array.isArray(j)) throw 0; } catch { throw new ApiError(500, 'catalog_sources_invalid', `${k} must be a JSON object`); } }
    out[k] = val.trim();
  }
  if (!!out.HP_COSTS_FOLDER_ID !== !!out.GDRIVE_API_KEY) throw new ApiError(500, 'catalog_sources_invalid', 'HP_COSTS_FOLDER_ID and GDRIVE_API_KEY go together');
  return out;
}

/** GET one source; returns { text, bytes, contentSha256 } or throws SourceError(code). */
async function fetchText(url, { fetchImpl, decode = 'utf-8-sig' }) {
  let res;
  try {
    res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { Accept: 'text/csv, text/plain;q=0.9, application/json;q=0.8, */*;q=0.1' } });
  } catch (e) {
    throw new SourceError(e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'network_error');
  }
  if (!res.ok) throw new SourceError(`http_${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_SOURCE_BYTES) throw new SourceError('too_large');
  if (/text\/html/i.test(res.headers.get('content-type') || '')) throw new SourceError('html_response');   // e.g. a sign-in page
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_SOURCE_BYTES) throw new SourceError('too_large');
  let text;
  try {
    text = decode === 'replace' ? new TextDecoder('utf-8', { ignoreBOM: true }).decode(buf)          // build.py: decode('utf-8', errors='replace')
                                : new TextDecoder('utf-8', { fatal: true }).decode(buf);            // decode('utf-8-sig'): strict, one BOM dropped
  } catch { throw new SourceError('not_utf8'); }
  if (!text.trim()) throw new SourceError('empty');
  if (/^\s*<(!doctype|html)/i.test(text.replace(/^\uFEFF/, ''))) throw new SourceError('html_response');
  return { text, bytes: buf.byteLength, contentSha256: await sha256(buf) };
}

/** build.py section 5A: the newest Shopify product export in the Drive folder. */
async function fetchDriveExport(folderId, key, { fetchImpl }) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const listUrl = `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=name+desc&pageSize=10&fields=files(id,name,mimeType)&key=${encodeURIComponent(key)}`;
  const list = await fetchText(listUrl, { fetchImpl });
  let files;
  try { files = JSON.parse(list.text).files || []; } catch { throw new SourceError('drive_list_invalid'); }
  const isSheet = f => String(f.mimeType || '').includes('spreadsheet');
  const ordered = [...files.filter(f => !isSheet(f)), ...files.filter(isSheet)];
  if (!ordered.length) throw new SourceError('drive_folder_empty');
  const best = ordered[0];
  if (typeof best.id !== 'string' || !/^[\w-]+$/.test(best.id)) throw new SourceError('drive_list_invalid');
  const dl = isSheet(best) ? `https://docs.google.com/spreadsheets/d/${best.id}/export?format=csv`
                           : `https://www.googleapis.com/drive/v3/files/${best.id}?alt=media&key=${encodeURIComponent(key)}`;
  const got = await fetchText(dl, { fetchImpl });
  return { ...got, name: String(best.name || '').slice(0, 120), fileIdSha256: await short(best.id), kind: isSheet(best) ? 'sheet' : 'file' };
}

/**
 * Fetch every configured source. Returns { texts, provenance, failures }.
 * provenance / failures carry names, hashes and codes only.
 */
export async function fetchCatalogSources(sources, { fetchImpl = fetch } = {}) {
  const texts = {}, provenance = {}, failures = {};
  const jobs = URL_SOURCES.filter(k => sources[k]).map(async k => {
    const urlSha256 = await short(sources[k]);
    try {
      const r = await fetchText(sources[k], { fetchImpl, decode: k === 'MCG_EXTRA_SHEET_URL' ? 'replace' : 'utf-8-sig' });
      texts[k] = r.text; provenance[k] = { urlSha256, bytes: r.bytes, contentSha256: r.contentSha256 };
    } catch (e) { failures[k] = e instanceof SourceError ? e.code : 'fetch_failed'; provenance[k] = { urlSha256 }; }
  });
  if (sources.HP_COSTS_FOLDER_ID) jobs.push((async () => {
    const folderSha256 = await short(sources.HP_COSTS_FOLDER_ID);
    try {
      const r = await fetchDriveExport(sources.HP_COSTS_FOLDER_ID, sources.GDRIVE_API_KEY, { fetchImpl });
      texts.productExport = { name: r.name, text: r.text };
      provenance.productExport = { folderSha256, fileName: r.name, fileIdSha256: r.fileIdSha256, kind: r.kind, bytes: r.bytes, contentSha256: r.contentSha256 };
    } catch (e) { failures.productExport = e instanceof SourceError ? e.code : 'fetch_failed'; provenance.productExport = { folderSha256 }; }
  })());
  await Promise.all(jobs);
  for (const k of JSON_SOURCES) if (sources[k]) { texts[k] = sources[k]; provenance[k] = { contentSha256: await sha256(sources[k]) }; }
  return { texts, provenance, failures };
}

/** C8: fetch failures worth retrying (the sheet host was unreachable or busy), by fixed code. */
export const isTransientCode = c => c === 'network_error' || c === 'timeout' || c === 'http_429' || /^http_5\d\d$/.test(c);
const allTransient = failures => { const v = Object.values(failures); return v.length > 0 && v.every(isTransientCode); };
/** With transientHold, a purely transient failure leaves the refresh pending (the caller retries) instead of rejecting it. */
const holdResult = (refreshId, failures, provenance, extra = {}) => {
  const reasons = Object.keys(failures).sort().map(k => `${k}: ${failures[k]}`);
  const refresh = { refreshId, status: 'pending', transient: true };
  return { rowsSeen: 0, written: 0, duplicates: 0, diagnostics: { kind: 'worker_fetch', accepted: false, transient: true, reasons, refresh, provenance, ...extra },
           response: { accepted: false, transient: true, catalogRev: null, reasons, refresh, provenance, ...extra } };
};

/** Fetch → build → validate → save → resolve the exact refresh. */
export async function refreshCatalog(env, { refreshId = null, fetchImpl = fetch, transientHold = false } = {}) {
  const sources = parseSources(env.CATALOG_SOURCES_JSON);
  const pre = await getSettings(env.DB);
  if (pre.catalog_overlay_base_rev) return refreshCatalogOverlay(env, { refreshId, fetchImpl, sources, baseRev: pre.catalog_overlay_base_rev, transientHold });
  return withRun(env, 'catalog', {}, async () => {
    const fetchedAt = nowIso();
    const { texts, provenance, failures } = await fetchCatalogSources(sources, { fetchImpl });
    const failed = Object.keys(failures).sort();
    if (failed.length && transientHold && allTransient(failures)) return holdResult(refreshId, failures, provenance);
    if (failed.length) {
      const reasons = failed.map(k => `${k}: ${failures[k]}`);
      const refresh = await resolveRefresh(env.DB, refreshId, { rev: null, accepted: false, reasons });
      return { rowsSeen: 0, written: 0, duplicates: 0, diagnostics: { accepted: false, reasons, refresh, provenance },
               response: { accepted: false, catalogRev: null, reasons, refresh, provenance } };
    }
    const settings = await getSettings(env.DB);
    let built;
    try { built = buildCatalogTables(texts, { livelyRootSource: settings.lively_root_cost_source }); }
    catch (e) {
      const reasons = [`parse_failed: ${e.code || 'error'}`];
      const refresh = await resolveRefresh(env.DB, refreshId, { rev: null, accepted: false, reasons });
      return { rowsSeen: 0, written: 0, duplicates: 0, diagnostics: { accepted: false, reasons, refresh, provenance },
               response: { accepted: false, catalogRev: null, reasons, refresh, provenance } };
    }
    const candidate = { tables: built.tables, mcgExtra: built.mcgExtra, overrides: {} };
    const prev = await latestAcceptedCatalogMeta(env.DB);
    const previous = prev ? { tableCounts: JSON.parse(prev.table_counts), vendorCounts: JSON.parse(prev.vendor_counts) } : null;
    const validation = validateCatalog(candidate, previous, { shrinkTolerance: Number(settings.catalog_shrink_tolerance) });
    const rev = await catalogRevOf(candidate);
    const meta = { fetchedAt, provenance, livelyRoot: built.report.livelyRoot, vendorStats: built.report.vendorStats, sourceCounts: built.report.sources, warnings: built.report.warnings.slice(0, 50) };
    const saved = await saveCatalog(env.DB, { rev, candidate, validation, source: 'worker_fetch', meta });
    const accepted = saved.duplicate ? saved.status === 'accepted' : validation.accepted;
    const refresh = await resolveRefresh(env.DB, refreshId, { rev, accepted, reasons: validation.reasons });
    return { rowsSeen: 1, written: saved.duplicate ? 0 : 1, duplicates: saved.duplicate ? 1 : 0,
             diagnostics: { kind: 'worker_fetch', catalogRev: rev, accepted, reasons: validation.reasons, refresh, provenance, livelyRoot: built.report.livelyRoot },
             response: { catalogRev: rev, accepted, status: saved.status, reasons: validation.reasons, refresh, provenance, livelyRoot: built.report.livelyRoot,
                         counts: validation.counts, activeCatalogRev: accepted ? rev : (prev?.catalog_rev || null) } };
  });
}

/** Admin: register a refresh for a week (or name a pending one) and answer it now. */
export async function adminCatalogFetch(request, env) {
  const body = await readJson(request);
  parseSources(env.CATALOG_SOURCES_JSON);                                      // fail before creating a refresh
  let refreshId = body.refreshId ?? null;
  if (refreshId !== null) {
    if (typeof refreshId !== 'string' || !REFRESH_ID_RE.test(refreshId)) throw new ApiError(400, 'bad_payload', 'refreshId is malformed');
    const r = await env.DB.prepare('SELECT status FROM catalog_refresh WHERE refresh_id = ?1').bind(refreshId).first();
    if (!r) throw new ApiError(404, 'refresh_unknown', `No catalog refresh ${refreshId}`);
    if (r.status !== 'pending') throw new ApiError(409, 'refresh_resolved', `Refresh ${refreshId} is already ${r.status}`);
  } else {
    const weekStart = mondayOrThrow(body.weekStart);
    const actor = actorFor('admin_secret', body);
    refreshId = newId('crf');
    await env.DB.prepare("INSERT INTO catalog_refresh (refresh_id, week_start, requested_at, requested_by_class, requested_by_label, status) VALUES (?1, ?2, ?3, ?4, ?5, 'pending')")
      .bind(refreshId, weekStart, nowIso(), actor.cls, actor.label).run();
  }
  return refreshCatalog(env, { refreshId });
}

// ─── C8: the Worker's own weekly catalog refresh (no admin HTTP call) ─────────

export const AUTO_REFRESH_RETRY_MS = 60 * 60_000;
export const CRON_REFRESH_ACTOR = Object.freeze({ cls: 'worker', label: 'cron' });

/** One logical refresh per week: a deterministic id, so concurrent ticks share it. */
export async function autoRefreshId(weekStart) {
  return `crf_${(await sha256(`auto-catalog-refresh:${weekStart}`)).slice(0, 20)}`;
}

/**
 * Create (once) and execute the week's catalog refresh from the public-sheet
 * configuration. Idempotent and concurrency-safe:
 *   • the refresh row has a deterministic id (INSERT … ON CONFLICT DO NOTHING);
 *   • each execution first claims the row by compare-and-swap on its detail
 *     (attempt counter), so two ticks never fetch for the same attempt;
 *   • success fulfils it (readiness satisfied; the compute pins its catalog);
 *     a rejected fetch rejects it and activates nothing (never an empty catalog);
 *   • a purely transient failure keeps it pending and is retried at most once
 *     per hour until `cutoffAt`, then it is rejected (`transient_retries_exhausted`);
 *   • audited catalog reuse (or any fulfilled refresh for the week) makes it unnecessary.
 * Returns codes only — never a URL, sheet id, gid or response content.
 */
export async function ensureWeeklyCatalogRefresh(env, { weekStart, at, cutoffAt, fetchImpl = fetch }) {
  const db = env.DB;
  const asOf = at.toISOString();
  const reuse = await db.prepare('SELECT 1 AS x FROM catalog_reuse_acceptance WHERE week_start = ?1 LIMIT 1').bind(weekStart).first();
  if (reuse) return { weekStart, action: 'none', reason: 'reuse_accepted' };
  const done = await db.prepare("SELECT refresh_id FROM catalog_refresh WHERE week_start = ?1 AND status = 'fulfilled' LIMIT 1").bind(weekStart).first();
  if (done) return { weekStart, action: 'none', reason: 'already_fulfilled', refreshId: done.refresh_id };
  const refreshId = await autoRefreshId(weekStart);
  await db.prepare(`INSERT INTO catalog_refresh (refresh_id, week_start, requested_at, requested_by_class, requested_by_label, status, detail)
      VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6) ON CONFLICT(refresh_id) DO NOTHING`)
    .bind(refreshId, weekStart, asOf, CRON_REFRESH_ACTOR.cls, CRON_REFRESH_ACTOR.label, JSON.stringify({ auto: true, attempts: 0 })).run();
  const row = await db.prepare('SELECT status, detail FROM catalog_refresh WHERE refresh_id = ?1').bind(refreshId).first();
  if (row.status !== 'pending') return { weekStart, action: 'none', reason: `refresh_${row.status}`, refreshId };
  let d = {}; try { d = JSON.parse(row.detail || '{}') || {}; } catch { d = {}; }
  if (d.attempts > 0 && d.lastAttemptAt && at.getTime() < Date.parse(d.lastAttemptAt) + AUTO_REFRESH_RETRY_MS) {
    return { weekStart, action: 'none', reason: 'retry_not_due', refreshId, retryAfter: d.retryAfter || null };
  }
  if (d.attempts > 0 && cutoffAt && at.getTime() > Date.parse(cutoffAt)) return { weekStart, action: 'none', reason: 'past_cutoff', refreshId };
  const next = { ...d, auto: true, attempts: (d.attempts || 0) + 1, lastAttemptAt: asOf };
  const claim = await db.prepare("UPDATE catalog_refresh SET detail = ?2 WHERE refresh_id = ?1 AND status = 'pending' AND detail = ?3")
    .bind(refreshId, JSON.stringify(next), row.detail).run();
  if (claim.meta.changes !== 1) return { weekStart, action: 'none', reason: 'claimed_elsewhere', refreshId };

  let out;
  try { out = await (await refreshCatalog(env, { refreshId, fetchImpl, transientHold: true })).json(); }
  catch (e) {
    // Configuration problems (sources unset or invalid, no base) are not transient.
    const reason = e instanceof ApiError ? e.code : 'fetch_failed';
    await resolveRefresh(db, refreshId, { rev: null, accepted: false, reasons: [reason] });
    return { weekStart, action: 'fetched', refreshId, status: 'rejected', reasons: [reason], attempt: next.attempts };
  }
  if (out.transient) {
    const retryAfter = new Date(at.getTime() + AUTO_REFRESH_RETRY_MS).toISOString();
    if (cutoffAt && Date.parse(retryAfter) > Date.parse(cutoffAt)) {
      await resolveRefresh(db, refreshId, { rev: null, accepted: false, reasons: ['transient_retries_exhausted', ...out.reasons] });
      return { weekStart, action: 'fetched', refreshId, status: 'rejected', reasons: ['transient_retries_exhausted'], attempt: next.attempts };
    }
    await db.prepare("UPDATE catalog_refresh SET detail = ?2 WHERE refresh_id = ?1 AND status = 'pending'")
      .bind(refreshId, JSON.stringify({ ...next, retryAfter, lastOutcome: out.reasons })).run();
    return { weekStart, action: 'fetched', refreshId, status: 'retrying', reasons: out.reasons, retryAfter, attempt: next.attempts };
  }
  return { weekStart, action: 'fetched', refreshId, status: out.refresh?.status || (out.accepted ? 'fulfilled' : 'rejected'),
           catalogRev: out.accepted ? out.catalogRev : null, reasons: out.reasons || [], attempt: next.attempts };
}

// ─── C6d: live Products Master tabs on the pinned base ────────────────────────

const rejectWith = async (env, refreshId, reasons, provenance = {}, extra = {}) => {
  const refresh = await resolveRefresh(env.DB, refreshId, { rev: null, accepted: false, reasons });
  return { rowsSeen: 0, written: 0, duplicates: 0, diagnostics: { kind: 'worker_fetch', mode: 'vendor_overlay', accepted: false, reasons, refresh, provenance, ...extra },
           response: { mode: 'vendor_overlay', accepted: false, catalogRev: null, reasons, refresh, provenance } };
};

/**
 * catalog_overlay_base_rev is set: fetch ONLY the five public Products Master
 * tabs, overlay them on the pinned base (never replacing or zeroing MCG/HPD or
 * any other base entry), validate against the last accepted catalog, save and
 * resolve the refresh. Any missing tab, fetch failure or parse failure rejects
 * the refresh and leaves the current catalog in place.
 */
async function refreshCatalogOverlay(env, { refreshId, fetchImpl, sources, baseRev, transientHold = false }) {
  return withRun(env, 'catalog', {}, async () => {
    const fetchedAt = nowIso();
    const missing = OVERLAY_SOURCES.filter(k => !sources[k]);
    if (missing.length) return rejectWith(env, refreshId, [`overlay_sources_missing: ${missing.join(', ')}`]);
    const baseRow = await env.DB.prepare('SELECT status FROM cost_catalog WHERE catalog_rev = ?1').bind(baseRev).first();
    if (!baseRow || baseRow.status !== 'base') return rejectWith(env, refreshId, [`overlay_base_missing: ${baseRev}`]);
    const only = Object.fromEntries(OVERLAY_SOURCES.map(k => [k, sources[k]]));
    const { texts, provenance, failures } = await fetchCatalogSources(only, { fetchImpl });
    const failed = Object.keys(failures).sort();
    if (failed.length && transientHold && allTransient(failures)) return holdResult(refreshId, failures, provenance, { mode: 'vendor_overlay' });
    if (failed.length) return rejectWith(env, refreshId, failed.map(k => `${k}: ${failures[k]}`), provenance);
    const settings = await getSettings(env.DB);
    let built, lr = null;
    try {
      built = buildCatalogTables(texts, { livelyRootSource: 'manual_list' });            // vendor tables only are used
      if (settings.lively_root_cost_source === 'sheet') lr = parseLivelyRootTab(pyCsvRows(texts.LIVELY_GOOD_SHEET_URL));
    } catch (e) { return rejectWith(env, refreshId, [`parse_failed: ${e.code || 'error'}`], provenance); }
    const base = await loadCatalog(env.DB, baseRev);
    let overlay;
    try { overlay = overlayVendorTabs(base, built, { livelyRootSource: settings.lively_root_cost_source, livelyRootCosts: lr?.costs || null }); }
    catch (e) { return rejectWith(env, refreshId, [`overlay_failed: ${e.code || 'error'}`], provenance); }
    const candidate = overlay.candidate;
    const prev = await latestAcceptedCatalogMeta(env.DB);
    const previous = prev ? { tableCounts: JSON.parse(prev.table_counts), vendorCounts: JSON.parse(prev.vendor_counts) } : null;
    const validation = validateCatalog(candidate, previous, { shrinkTolerance: Number(settings.catalog_shrink_tolerance) });
    const rev = await catalogRevOf(candidate);
    const completeness = catalogCompleteness({ baseCatalogRev: baseRev, base });
    const vendorStats = built.report.vendorStats;
    const costIssues = Object.fromEntries(vendorStats.map(v => [v.vendor, { invalid: v.invalid_costs || 0, conflicting: v.conflicting_duplicates || 0, zeroOrNegative: v.zero_or_negative || 0 }]));
    const meta = { kind: 'vendor_overlay', fetchedAt, baseCatalogRev: baseRev, provenance, livelyRoot: built.report.livelyRoot, vendorStats, costIssues,
                   overlay: overlay.report, completeness, warnings: built.report.warnings.filter(w => !/ not set /.test(w)).slice(0, 50) };
    const saved = await saveCatalog(env.DB, { rev, candidate, validation, source: 'worker_fetch_overlay', meta });
    const accepted = saved.duplicate ? saved.status === 'accepted' : validation.accepted;
    const refresh = await resolveRefresh(env.DB, refreshId, { rev, accepted, reasons: validation.reasons });
    return { rowsSeen: 1, written: saved.duplicate ? 0 : 1, duplicates: saved.duplicate ? 1 : 0,
             diagnostics: { kind: 'worker_fetch', mode: 'vendor_overlay', catalogRev: rev, baseCatalogRev: baseRev, accepted, reasons: validation.reasons,
                            refresh, provenance, livelyRoot: built.report.livelyRoot, costIssues, completeness: { status: completeness.status, unresolved: completeness.unresolvedSources.length } },
             response: { mode: 'vendor_overlay', catalogRev: rev, baseCatalogRev: baseRev, accepted, status: saved.status, reasons: validation.reasons, refresh,
                         provenance, livelyRoot: built.report.livelyRoot, overlay: overlay.report, costIssues, completeness,
                         counts: validation.counts, activeCatalogRev: accepted ? rev : (prev?.catalog_rev || null) } };
  });
}

/**
 * POST /v1/admin/catalog/base { tables, mcgExtra?, overrides?, reason, label? }
 * Register the pinned base (existing non-vendor cost tables). It is stored as
 * status 'base': it never becomes the active catalog. Point the overlay at it
 * with the audited setting catalog_overlay_base_rev. The rev is content-addressed,
 * so the same files always give the same rev.
 */
export async function adminCatalogBase(request, env) {
  const body = await readJson(request);
  const reason = String(body.reason || '').trim();
  if (reason.length < 10) throw new ApiError(400, 'bad_payload', 'Registering a base catalog needs a reason of at least 10 characters');
  const base = { tables: body.tables, mcgExtra: body.mcgExtra || {}, overrides: body.overrides || {} };
  const v = validateBaseCatalog(base);
  if (!v.accepted) throw new ApiError(400, 'base_invalid', v.reasons.join('; ').slice(0, 500));
  const rev = await catalogRevOf(base);
  const actor = actorFor('admin_secret', body);
  const label = typeof body.label === 'string' ? body.label.slice(0, 80) : null;
  const saved = await saveBaseCatalog(env.DB, { rev, base, counts: v.counts, meta: { kind: 'base', reason, label, actorClass: actor.cls, actorLabel: actor.label, registeredAt: nowIso() } });
  if (saved.duplicate && saved.status !== 'base') throw new ApiError(409, 'rev_in_use', `${rev} already exists as a ${saved.status} catalog`);
  return json({ baseCatalogRev: rev, status: 'base', duplicate: saved.duplicate, counts: v.counts });
}
