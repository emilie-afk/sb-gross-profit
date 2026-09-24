/**
 * ingest.js — versioned ingestion routes (X-Ingest-Secret)
 * =======================================================
 * POST /v1/ingest/shopify      { format: 'graphql', nodes } | { format: 'normalized', orders }, weekStart?
 * POST /v1/ingest/shipstation  { format: 'rows', rows, sourceFormat?: 'custom'|'legacy' }, weekStart?
 * POST /v1/ingest/hpd          { format: 'normalized', hpdOrders } | { format: 'rows', rows } | { format: 'csv_text', text }
 * POST /v1/ingest/catalog      { tables, mcgExtra? | mcgExtraCsv?, overrides?, meta? }
 *
 *   body.mode (shopify): 'week' (the cycle's orders) | 'updated_since' (earlier orders changed since the week began)
 *   body.meta.refreshId (catalog): the catalog_refresh this build answers
 * GET  /v1/ingest/week-plan     the cycle's week, UTC window and Shopify search strings
 *
 * Every call is idempotent: an unchanged record is a duplicate, not a write,
 * so Make retries are harmless. Customer fields are rejected, not dropped.
 * Each run records `weeks_touched` ({ week: changed records }) so earlier
 * weeks affected by this cycle get draft revisions (admin reviseTouchedWeeks).
 */
import { ApiError, json, readJson, WEEK_RE } from './http.js';
import { newId, nowIso, getSettings } from './db.js';
import { saveOrders, saveShipments, saveHpd, saveCatalog, latestAcceptedCatalogMeta } from './store.js';
import { normalizeShopifyOrders } from '../../shared/adapters/shopifyGraphql.js';
import { normalizeShipStationRows } from '../../shared/adapters/shipstation.js';
import { normalizeHpdRows } from '../../shared/adapters/hpd.js';
import { parseCSV } from '../../shared/calculator.js';
import { CustomerDataError, assertNoCustomerFields, filterNoteAttributes } from '../../shared/normalized.js';
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

async function withRun(env, source, body, fn) {
  const weekStart = weekOf(body);
  let mode = null;
  if (source === 'shopify') {
    mode = body.mode || 'week';
    if (!MODES.has(mode)) throw new ApiError(400, 'bad_payload', "mode must be 'week' or 'updated_since'");
  }
  const runId = await startRun(env.DB, source, weekStart, mode);
  try {
    const r = await fn(runId);
    await finishRun(env.DB, runId, { status: 'ok', ...r });
    return json({ runId, source, weekStart, mode, rowsSeen: r.rowsSeen, rowsWritten: r.written, duplicates: r.duplicates,
                  weeksTouched: r.weeksTouched || {}, ...(r.response || {}) });
  } catch (e) {
    const code = e instanceof CustomerDataError ? 'customer_data_rejected' : (e instanceof ApiError ? e.code : (e.code || 'ingest_failed'));
    await finishRun(env.DB, runId, { status: 'failed', error: code });
    if (e instanceof CustomerDataError) throw new ApiError(400, 'customer_data_rejected', 'Payload contains customer fields; fix the query or export template', { paths: e.paths.slice(0, 10) });
    if (e instanceof ApiError) throw e;
    if (e.code === 'bad_payload') throw new ApiError(400, 'bad_payload', e.message);
    throw e;
  }
}

export async function ingestShopify(request, env) {
  const body = await readJson(request);
  return withRun(env, 'shopify', body, async runId => {
    const settings = await getSettings(env.DB);
    let orders;
    if (body.format === 'graphql') {
      if (!Array.isArray(body.nodes)) throw new ApiError(400, 'bad_payload', 'nodes must be an array');
      orders = normalizeShopifyOrders(body.nodes, { timeZone: settings.store_timezone });
    } else if (body.format === 'normalized') {
      if (!Array.isArray(body.orders)) throw new ApiError(400, 'bad_payload', 'orders must be an array');
      assertNoCustomerFields(body.orders);
      // Same allowlist as the graphql and CSV paths: attribute VALUES can hold
      // gift messages or names, so only Channel / sample attributes are kept.
      orders = body.orders.map(o => ({ ...o, noteAttributes: filterNoteAttributes(o.noteAttributes) }));
      // Pre-normalized orders carry store-local dates; the sender must state the
      // zone they were normalized in, and it must be the current store zone.
      if (body.storeTimezone !== settings.store_timezone) {
        throw new ApiError(400, 'timezone_mismatch', `storeTimezone must be ${settings.store_timezone} (the current store time zone); got ${body.storeTimezone ?? 'none'}`);
      }
    } else throw new ApiError(400, 'bad_payload', "format must be 'graphql' or 'normalized'");
    const r = await saveOrders(env.DB, orders, runId, { timeZone: settings.store_timezone });
    return { rowsSeen: orders.length, written: r.written, duplicates: r.duplicates, weeksTouched: r.weeksTouched };
  });
}

export async function ingestShipStation(request, env) {
  const body = await readJson(request);
  return withRun(env, 'shipstation', body, async runId => {
    if (body.format !== 'rows' || !Array.isArray(body.rows)) throw new ApiError(400, 'bad_payload', "Send { format: 'rows', rows: [...] }");
    let normalized;
    try { normalized = normalizeShipStationRows(body.rows, { sourceFormat: body.sourceFormat === 'legacy' ? 'legacy' : 'custom' }); }
    catch (e) { throw new ApiError(400, 'bad_payload', e.message); }
    const r = await saveShipments(env.DB, normalized.shipments, runId);
    return { rowsSeen: body.rows.length, written: r.written, duplicates: r.duplicates, weeksTouched: r.weeksTouched,
             diagnostics: normalized.diagnostics, response: { diagnostics: normalized.diagnostics } };
  });
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
async function resolveRefresh(db, refreshId, { rev, accepted, reasons }) {
  if (refreshId === undefined || refreshId === null || refreshId === '') return { status: 'none', note: 'no refreshId in this push; no refresh resolved' };
  if (typeof refreshId !== 'string' || !REFRESH_ID_RE.test(refreshId)) return { status: 'invalid', note: 'malformed refreshId; no refresh resolved' };
  const r = await db.prepare('SELECT status, requested_at FROM catalog_refresh WHERE refresh_id = ?1').bind(refreshId).first();
  if (!r) return { refreshId, status: 'unknown', note: 'no such refresh; nothing resolved' };
  if (r.status !== 'pending') return { refreshId, status: r.status, note: 'already resolved; unchanged' };
  if (Date.now() - Date.parse(r.requested_at) > REFRESH_TIMEOUT_MINUTES * 60_000) {
    await db.prepare("UPDATE catalog_refresh SET status = 'expired', resolved_at = ?2, detail = ?3 WHERE refresh_id = ?1 AND status = 'pending'")
      .bind(refreshId, nowIso(), JSON.stringify({ lateCandidateRev: rev, note: `arrived after ${REFRESH_TIMEOUT_MINUTES} minutes` })).run();
    return { refreshId, status: 'expired', note: 'refresh timed out before this push; not fulfilled' };
  }
  const status = accepted ? 'fulfilled' : 'rejected';
  const u = await db.prepare('UPDATE catalog_refresh SET status = ?2, catalog_rev = ?3, resolved_at = ?4, detail = ?5 WHERE refresh_id = ?1 AND status = ?6')
    .bind(refreshId, status, accepted ? rev : null, nowIso(), JSON.stringify({ reasons: reasons || [], candidateRev: rev }), 'pending').run();
  return { refreshId, status: u.meta.changes === 1 ? status : 'already_resolved' };
}
