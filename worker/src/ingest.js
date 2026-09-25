/**
 * ingest.js — versioned ingestion routes (X-Ingest-Secret)
 * =======================================================
 * POST /v1/ingest/shopify      { format: 'csv_text', text, weekStart, mode?: 'rolling', sanitizedSha256? }
 *                               | { format: 'normalized', orders, storeTimezone }   (manual / backfill)
 *                               format 'graphql' is refused: there is no Shopify API integration
 * POST /v1/ingest/shipstation  { format: 'rows', rows, sourceFormat?: 'custom'|'legacy' }
 *                               | { format: 'csv_text', text, weekStart, sanitizedSha256? }
 * POST /v1/ingest/hpd          { format: 'normalized', hpdOrders } | { format: 'rows', rows } | { format: 'csv_text', text }
 * POST /v1/ingest/catalog      { tables, mcgExtra? | mcgExtraCsv?, overrides?, meta? }
 *
 *   body.mode (shopify): 'week' (the cycle's orders) | 'updated_since' (earlier orders changed since the week began)
 *   body.meta.refreshId (catalog): the catalog_refresh this build answers
 * GET  /v1/ingest/week-plan     the cycle's week, UTC window and Shopify search strings
 *
 * Every call is idempotent: an unchanged record is a duplicate, not a write,
 * so collector retries are harmless. Customer fields are rejected, not dropped.
 *
 * csv_text uploads come from the Windows collector, already sanitized on that
 * machine. The Worker hashes the payload as received: identical content again
 * answers `sourceStatus: 'source_no_change'` (200), new content
 * `'source_received'`. A Shopify `mode: 'rolling'` upload (the rolling eight-week
 * orders export) is both the week's orders and the updated earlier orders, so on
 * success it records the `week` run and an `updated_since` companion run.
 * Each run records `weeks_touched` ({ week: changed records }) so earlier
 * weeks affected by this cycle get draft revisions (admin reviseTouchedWeeks).
 */
import { ApiError, json, readJson, WEEK_RE } from './http.js';
import { newId, nowIso, getSettings, markCyclesChanged } from './db.js';
import { saveOrders, saveShipments, saveHpd, saveCatalog, latestAcceptedCatalogMeta } from './store.js';
import { normalizeShipStationRows, SHIPSTATION_MAPPING_EXPORT_COLUMNS } from '../../shared/adapters/shipstation.js';
import { normalizeHpdRows } from '../../shared/adapters/hpd.js';
import { parseCSV } from '../../shared/calculator.js';
import { CustomerDataError, assertNoCustomerFields, filterNoteAttributes } from '../../shared/normalized.js';
import { csvRowsToNormalizedOrders } from '../../shared/adapters/legacy.js';
import { assertSanitizedShopifyOrderRows, currenciesOf } from '../../shared/adapters/shopifyCsv.js';
import { assertReducedShopifyOrderRows, assertReducedNormalizedOrders } from '../../shared/adapters/shopifyPrivacy.js';
import { validateCatalog, catalogRevOf, parseMcgExtraCsv } from '../../shared/catalog.js';
import { REFRESH_TIMEOUT_MINUTES } from './compute.js';

const MODES = new Set(['week', 'updated_since']);

async function startRun(db, source, weekStart, mode) {
  const runId = newId('ing');
  await db.prepare('INSERT INTO ingest_run (run_id, source, week_start, started_at, status, mode) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(runId, source, weekStart || null, nowIso(), 'running', mode || null).run();
  return runId;
}

async function finishRun(db, runId, { status, rowsSeen = 0, written = 0, duplicates = 0, error = null, diagnostics = {}, weeksTouched = {} }) {
  await db.prepare(`UPDATE ingest_run SET finished_at = ?2, status = ?3, rows_seen = ?4, rows_written = ?5, duplicates = ?6,
    error = ?7, diagnostics = ?8, weeks_touched = ?9 WHERE run_id = ?1`)
    .bind(runId, nowIso(), status, rowsSeen, written, duplicates, error, JSON.stringify(diagnostics), JSON.stringify(weeksTouched || {})).run();
}

function weekOf(body) {
  if (body.weekStart === undefined || body.weekStart === null) return null;
  if (!WEEK_RE.test(body.weekStart)) throw new ApiError(400, 'bad_payload', 'weekStart must be YYYY-MM-DD');
  return body.weekStart;
}

export async function withRun(env, source, body, fn, { mode: forcedMode, onSuccess } = {}) {
  const weekStart = weekOf(body);
  let mode = null;
  if (source === 'shopify') {
    mode = forcedMode || body.mode || 'week';
    if (!MODES.has(mode)) throw new ApiError(400, 'bad_payload', "mode must be 'week' or 'updated_since'");
  }
  const runId = await startRun(env.DB, source, weekStart, mode);
  try {
    const r = await fn(runId);
    await finishRun(env.DB, runId, { status: 'ok', ...r });
    // C7: the cycle of this week (and any week whose records changed) retries on the next tick.
    await markCyclesChanged(env.DB, [weekStart, ...Object.keys(r.weeksTouched || {})]);
    const extra = onSuccess ? await onSuccess(runId, r, weekStart) : {};
    return json({ runId, source, weekStart, mode, rowsSeen: r.rowsSeen, rowsWritten: r.written, duplicates: r.duplicates,
                  weeksTouched: r.weeksTouched || {}, ...(r.response || {}), ...extra });
  } catch (e) {
    const code = e instanceof CustomerDataError ? 'customer_data_rejected' : (e instanceof ApiError ? e.code : (e.code || 'ingest_failed'));
    await finishRun(env.DB, runId, { status: 'failed', error: code });
    if (e instanceof CustomerDataError) throw new ApiError(400, 'customer_data_rejected', 'Payload contains customer fields; fix the query or export template', { paths: e.paths.slice(0, 10) });
    if (e instanceof ApiError) throw e;
    if (e.code === 'bad_payload' || e.code === 'unapproved_value') throw new ApiError(400, e.code, e.message);
    throw e;
  }
}

export async function ingestShopify(request, env) {
  const body = await readJson(request);
  // No Shopify API integration exists for this project. The Revision 8 GraphQL
  // adapter stays in the repository only until cleanup; no route, setting or
  // secret can reach it.
  if (body.format === 'graphql') throw new ApiError(400, 'format_unavailable', "Shopify API ingestion is not available; send format 'csv_text'");
  const rolling = body.format === 'csv_text' && body.mode === 'rolling';
  if (body.format === 'csv_text') requireCsvUpload(body);
  const upload = body.format === 'csv_text' ? await uploadHash(body) : null;
  return withRun(env, 'shopify', body, async runId => {
    const settings = await getSettings(env.DB);
    let orders, diagnostics = {};
    if (body.format === 'csv_text') {
      const rows = parseCSV(body.text);
      assertSanitizedShopifyOrderRows(rows);                  // customer columns → rejected, not dropped
      assertReducedShopifyOrderRows(rows);                    // free text must already be in its minimum form
      orders = csvRowsToNormalizedOrders(rows);
      diagnostics = { csvRows: rows.length, currencies: currenciesOf(rows), sanitizedSha256: upload.sha256 };
    } else if (body.format === 'normalized') {
      if (!Array.isArray(body.orders)) throw new ApiError(400, 'bad_payload', 'orders must be an array');
      assertNoCustomerFields(body.orders);
      assertReducedNormalizedOrders(body.orders);             // same privacy contract as csv_text
      // Same allowlist as the CSV path: attribute VALUES can hold
      // gift messages or names, so only Channel / sample attributes are kept.
      orders = body.orders.map(o => ({ ...o, noteAttributes: filterNoteAttributes(o.noteAttributes) }));
      // Pre-normalized orders carry store-local dates; the sender must state the
      // zone they were normalized in, and it must be the current store zone.
      if (body.storeTimezone !== settings.store_timezone) {
        throw new ApiError(400, 'timezone_mismatch', `storeTimezone must be ${settings.store_timezone} (the current store time zone); got ${body.storeTimezone ?? 'none'}`);
      }
    } else throw new ApiError(400, 'bad_payload', "format must be 'csv_text' or 'normalized'");
    const r = await saveOrders(env.DB, orders, runId, { timeZone: settings.store_timezone });
    return { rowsSeen: orders.length, written: r.written, duplicates: r.duplicates, weeksTouched: r.weeksTouched, diagnostics };
  }, {
    mode: rolling ? 'week' : undefined,
    onSuccess: async (runId, r, weekStart) => {
      const out = upload ? await recordUpload(env.DB, 'shopify', upload, runId, r.rowsSeen) : {};
      if (rolling) {
        // The rolling export also carries every earlier order changed since: the
        // same content satisfies the week's `updated_since` input.
        const companion = await startRun(env.DB, 'shopify', weekStart, 'updated_since');
        await finishRun(env.DB, companion, { status: 'ok', rowsSeen: r.rowsSeen, written: 0, duplicates: r.rowsSeen,
          diagnostics: { companionOf: runId, sanitizedSha256: upload.sha256, note: 'rolling export: same upload as the week run' },
          weeksTouched: {} });
        out.updatedSinceRunId = companion;
      }
      return out;
    },
  });
}

/** csv_text uploads: the collector's sanitized payload, tied to a reporting week. */
function requireCsvUpload(body) {
  if (typeof body.text !== 'string' || !body.text.trim()) throw new ApiError(400, 'bad_payload', 'text must be the sanitized CSV');
  if (!body.weekStart || !WEEK_RE.test(body.weekStart)) throw new ApiError(400, 'bad_payload', 'weekStart (YYYY-MM-DD) is required for csv_text uploads');
  if (body.mode !== undefined && !['rolling', 'week', 'updated_since'].includes(body.mode)) throw new ApiError(400, 'bad_payload', "mode must be 'rolling', 'week' or 'updated_since'");
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Hash of the sanitized payload as received; a sender-stated hash must agree. */
async function uploadHash(body) {
  const sha256 = await sha256Hex(body.text);
  if (body.sanitizedSha256 !== undefined && body.sanitizedSha256 !== sha256) {
    throw new ApiError(400, 'hash_mismatch', 'sanitizedSha256 does not match the payload received');
  }
  return { sha256 };
}

/** Record a successful upload; identical content again is `source_no_change`. */
async function recordUpload(db, source, { sha256 }, runId, rowCount) {
  const now = nowIso();
  const seen = await db.prepare('SELECT first_run_id FROM source_upload WHERE source = ?1 AND sha256 = ?2').bind(source, sha256).first();
  if (seen) {
    await db.prepare('UPDATE source_upload SET last_received_at = ?3, times_received = times_received + 1 WHERE source = ?1 AND sha256 = ?2')
      .bind(source, sha256, now).run();
    return { sourceStatus: 'source_no_change', sourceHash: sha256, firstRunId: seen.first_run_id };
  }
  await db.prepare(`INSERT INTO source_upload (source, sha256, first_run_id, first_received_at, last_received_at, times_received, row_count)
      VALUES (?1, ?2, ?3, ?4, ?4, 1, ?5) ON CONFLICT (source, sha256) DO UPDATE SET last_received_at = ?4, times_received = times_received + 1`)
    .bind(source, sha256, runId, now, rowCount ?? null).run();
  return { sourceStatus: 'source_received', sourceHash: sha256 };
}

export async function ingestShipStation(request, env) {
  const body = await readJson(request);
  if (body.format === 'csv_text') requireCsvUpload(body);
  const upload = body.format === 'csv_text' ? await uploadHash(body) : null;
  return withRun(env, 'shipstation', body, async runId => {
    let rows;
    if (body.format === 'rows' && Array.isArray(body.rows)) rows = body.rows;
    else if (body.format === 'csv_text') {
      rows = parseCSV(body.text);
      // Exactly the saved template's columns (an allowlist, not banned names): any
      // other column means the template changed, so the upload is refused.
      const allowed = new Set(SHIPSTATION_MAPPING_EXPORT_COLUMNS);
      const bad = (rows.length ? Object.keys(rows[0]) : []).filter(h => !allowed.has(h));
      if (bad.length) throw new CustomerDataError(bad.map(h => `$.columns.${h}`));
    } else throw new ApiError(400, 'bad_payload', "Send { format: 'rows', rows: [...] } or { format: 'csv_text', text, weekStart }");
    let normalized;
    try { normalized = normalizeShipStationRows(rows, { sourceFormat: body.sourceFormat === 'legacy' ? 'legacy' : 'custom' }); }
    catch (e) { throw new ApiError(400, 'bad_payload', e.message); }
    const r = await saveShipments(env.DB, normalized.shipments, runId);
    const diagnostics = upload ? { ...normalized.diagnostics, sanitizedSha256: upload.sha256 } : normalized.diagnostics;
    return { rowsSeen: rows.length, written: r.written, duplicates: r.duplicates, weeksTouched: r.weeksTouched,
             diagnostics, response: { diagnostics: normalized.diagnostics } };
  }, { onSuccess: async (runId, r) => (upload ? recordUpload(env.DB, 'shipstation', upload, runId, r.rowsSeen) : {}) });
}

export async function ingestHpd(request, env) {
  const body = await readJson(request);
  return withRun(env, 'hpd', body, async runId => {
    let rows, hpd;
    if (body.format === 'normalized' && Array.isArray(body.hpdOrders)) {
      assertNoCustomerFields(body.hpdOrders);
      rows = body.hpdOrders; hpd = body.hpdOrders;
    } else {
      if (body.format === 'rows' && Array.isArray(body.rows)) rows = body.rows;
      else if (body.format === 'csv_text' && typeof body.text === 'string') rows = parseCSV(body.text);
      else throw new ApiError(400, 'bad_payload', "Send { format: 'normalized', hpdOrders }, { format: 'rows', rows } or { format: 'csv_text', text }");
      hpd = normalizeHpdRows(rows);            // buyer notes are read for the order number, then discarded
    }
    const r = await saveHpd(env.DB, hpd, runId);
    return { rowsSeen: rows.length, written: r.written, duplicates: r.duplicates, weeksTouched: r.weeksTouched, response: { hpdOrders: hpd.length } };
  });
}

export async function ingestCatalog(request, env) {
  const body = await readJson(request);
  return withRun(env, 'catalog', body, async () => {
    if (!body.tables || typeof body.tables !== 'object') throw new ApiError(400, 'bad_payload', 'tables is required');
    const candidate = {
      tables: body.tables,
      mcgExtra: body.mcgExtra || (typeof body.mcgExtraCsv === 'string' ? parseMcgExtraCsv(body.mcgExtraCsv) : {}),
      overrides: body.overrides || {},
    };
    const settings = await getSettings(env.DB);
    const prev = await latestAcceptedCatalogMeta(env.DB);
    const previous = prev ? { tableCounts: JSON.parse(prev.table_counts), vendorCounts: JSON.parse(prev.vendor_counts) } : null;
    const validation = validateCatalog(candidate, previous, { shrinkTolerance: Number(settings.catalog_shrink_tolerance) });
    const rev = await catalogRevOf(candidate);
    const meta = { builtAt: body.meta?.builtAt || null, commit: body.meta?.commit || null };
    const saved = await saveCatalog(env.DB, { rev, candidate, validation, source: body.meta?.source || 'build_push', meta });
    // A duplicate keeps its original verdict: resubmitting rejected content stays rejected.
    const accepted = saved.duplicate ? saved.status === 'accepted' : validation.accepted;
    const refresh = await resolveRefresh(env.DB, body.meta?.refreshId, { rev, accepted, reasons: validation.reasons });
    return { rowsSeen: 1, written: saved.duplicate ? 0 : 1, duplicates: saved.duplicate ? 1 : 0,
             diagnostics: { catalogRev: rev, accepted, reasons: validation.reasons, refresh },
             response: { catalogRev: rev, accepted, status: saved.status, reasons: validation.reasons, refresh,
                         counts: validation.counts, activeCatalogRev: accepted ? rev : (prev?.catalog_rev || null) } };
  });
}

export const REFRESH_ID_RE = /^crf_[0-9a-f]{20}$/;

/**
 * Close the ONE catalog refresh a build names. A push resolves only the exact
 * id it carries — never "the latest refresh" — so a build without an id, or
 * with a malformed, unknown, expired or already-resolved id, resolves nothing.
 */
export async function resolveRefresh(db, refreshId, { rev, accepted, reasons }) {
  if (refreshId === undefined || refreshId === null || refreshId === '') return { status: 'none', note: 'no refreshId in this push; no refresh resolved' };
  if (typeof refreshId !== 'string' || !REFRESH_ID_RE.test(refreshId)) return { status: 'invalid', note: 'malformed refreshId; no refresh resolved' };
  const r = await db.prepare('SELECT status, requested_at, detail FROM catalog_refresh WHERE refresh_id = ?1').bind(refreshId).first();
  if (!r) return { refreshId, status: 'unknown', note: 'no such refresh; nothing resolved' };
  if (r.status !== 'pending') return { refreshId, status: r.status, note: 'already resolved; unchanged' };
  let prior = {}; try { prior = JSON.parse(r.detail || '{}') || {}; } catch { prior = {}; }
  // C8: the Worker's own weekly refresh retries transient failures hourly up to
  // the cutoff, so the 45-minute build-hook expiry does not apply to it.
  if (!prior.auto && Date.now() - Date.parse(r.requested_at) > REFRESH_TIMEOUT_MINUTES * 60_000) {
    await db.prepare("UPDATE catalog_refresh SET status = 'expired', resolved_at = ?2, detail = ?3 WHERE refresh_id = ?1 AND status = 'pending'")
      .bind(refreshId, nowIso(), JSON.stringify({ lateCandidateRev: rev, note: `arrived after ${REFRESH_TIMEOUT_MINUTES} minutes` })).run();
    return { refreshId, status: 'expired', note: 'refresh timed out before this push; not fulfilled' };
  }
  const status = accepted ? 'fulfilled' : 'rejected';
  const u = await db.prepare('UPDATE catalog_refresh SET status = ?2, catalog_rev = ?3, resolved_at = ?4, detail = ?5 WHERE refresh_id = ?1 AND status = ?6')
    .bind(refreshId, status, accepted ? rev : null, nowIso(), JSON.stringify({ ...prior, reasons: reasons || [], candidateRev: rev }), 'pending').run();
  if (u.meta.changes === 1) {
    const w = await db.prepare('SELECT week_start FROM catalog_refresh WHERE refresh_id = ?1').bind(refreshId).first();
    await markCyclesChanged(db, [w?.week_start]);
  }
  return { refreshId, status: u.meta.changes === 1 ? status : 'already_resolved' };
}
