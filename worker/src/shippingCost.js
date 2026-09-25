/**
 * shippingCost.js — Shipping Cost Report source versions (Revision 9, C2)
 * ======================================================================
 * POST /v1/ingest/shipping-cost-report   sanitized report from the Windows collector (X-Ingest-Secret)
 * GET  /v1/admin/shipping-cost/versions                 list
 * GET  /v1/admin/shipping-cost/versions/:id             one version with its comparison
 * POST /v1/admin/shipping-cost/versions/:id/accept      { reason }  pending_review → accepted (activates)
 * POST /v1/admin/shipping-cost/versions/:id/reject      { reason }  pending_review → rejected
 * POST /v1/admin/shipping-cost/activations/:id/rollback { reason }  undo the LATEST activation exactly
 * GET  /v1/admin/shipping-cost/segments                 the active non-overlapping ship-date segments
 * GET  /v1/admin/shipping-cost/effective                effective per-order totals (aggregate summary)
 *
 * Model. Every import is an immutable version (rows + per-order aggregate).
 * Active data is a set of NON-OVERLAPPING ship-date segments, each owned by one
 * accepted version; effective totals read each ship date from exactly one
 * version. A newly accepted version replaces the active version only for its
 * own requested range; earlier dates keep their versions. Every activation
 * stores the full segment set it replaced, so rollback is exact.
 *
 * A version is accepted automatically only when the overlap with the active
 * data reconciles exactly (same order totals, row counts, first/last dates),
 * the range leaves no gap, there are no review flags, and the trailing dates are
 * complete (the export was taken after the last requested day). Anything else —
 * including the very first version — waits for an admin decision. An unexplained
 * change is never promoted.
 *
 * Nothing here changes the financial calculation (C3 does). Money is integer
 * cents. No row, filename or value is ever logged.
 */
import { ApiError, json, readJson } from './http.js';
import { newId, nowIso, getSettings, jsonInsert, atomic, selectIn, markCyclesChanged } from './db.js';
import { actorFor, actorJson } from './actor.js';
import { parseCSV } from '../../shared/calculator.js';
import { addDays, contentHash, weekStartOf } from '../../shared/normalized.js';
import { parseShippingCostReport, aggregateByOrder, fromCents, toCents, SCHEMA_VERSION } from '../../shared/adapters/shippingCostReport.js';

const ROW_COLS = ['version_id', 'row_seq', 'ship_date_raw', 'ship_date', 'order_key', 'provider', 'service', 'package', 'items', 'zone',
  'shipping_cost_cents', 'insurance_cents', 'duties_cents', 'taxes_cents', 'import_fee_cents', 'weight', 'weight_unit', 'store', 'row_hash'];
const AGG_COLS = ['version_id', 'order_key', 'cost_cents', 'row_count', 'first_ship_date', 'last_ship_date'];
const isGuardAbort = e => /NOT NULL constraint failed: write_guard/i.test(String(e?.message || e));
const reasonOrThrow = (r, what) => { const s = String(r || '').trim(); if (s.length < 5) throw new ApiError(400, 'bad_payload', `${what} needs a stated reason`); return s; };

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
/** Calendar date (YYYY-MM-DD) of an instant in a time zone. */
const dateIn = (iso, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

// ─── Active segments ──────────────────────────────────────────────────────────

export async function activeSegments(db) {
  return ((await db.prepare('SELECT seg_from, seg_to, version_id, activation_id FROM shipping_cost_active_segment ORDER BY seg_from').all()).results || [])
    .map(s => ({ segFrom: s.seg_from, segTo: s.seg_to, versionId: s.version_id, activationId: s.activation_id }));
}

/** Pure: the segment set after giving [from, to] to `versionId`. Earlier dates keep their versions. */
export function replaceRange(segments, from, to, versionId, activationId) {
  const out = [];
  for (const s of segments) {
    if (s.segTo < from || s.segFrom > to) { out.push(s); continue; }
    if (s.segFrom < from) out.push({ ...s, segTo: addDays(from, -1) });
    if (s.segTo > to) out.push({ ...s, segFrom: addDays(to, 1) });
  }
  out.push({ segFrom: from, segTo: to, versionId, activationId });
  return out.sort((a, b) => (a.segFrom < b.segFrom ? -1 : 1));
}

/** Pure: true when the segments cover one contiguous date range. */
export function contiguous(segments) {
  const s = [...segments].sort((a, b) => (a.segFrom < b.segFrom ? -1 : 1));
  for (let i = 1; i < s.length; i++) if (addDays(s[i - 1].segTo, 1) !== s[i].segFrom) return false;
  return true;
}

/** Rows of the active data whose ship date is in [from, to] (each date from exactly one version). */
async function activeRowsInRange(db, from, to) {
  const r = await db.prepare(`SELECT r.order_key, r.ship_date, r.shipping_cost_cents FROM shipping_cost_row r
      JOIN shipping_cost_active_segment s ON r.version_id = s.version_id AND r.ship_date BETWEEN s.seg_from AND s.seg_to
      WHERE r.ship_date BETWEEN ?1 AND ?2`).bind(from, to).all();
  return (r.results || []).map(x => ({ orderKey: x.order_key, shipDate: x.ship_date, shippingCostCents: x.shipping_cost_cents }));
}

/** Effective per-order totals over the active segments (the C3 expense input). */
export async function effectiveOrderTotals(db) {
  const r = await db.prepare(`SELECT r.order_key, SUM(r.shipping_cost_cents) AS cost_cents, COUNT(*) AS row_count,
        MIN(r.ship_date) AS first_ship_date, MAX(r.ship_date) AS last_ship_date
      FROM shipping_cost_row r
      JOIN shipping_cost_active_segment s ON r.version_id = s.version_id AND r.ship_date BETWEEN s.seg_from AND s.seg_to
      GROUP BY r.order_key`).all();
  return new Map((r.results || []).map(x => [x.order_key, { orderKey: x.order_key, costCents: x.cost_cents, rowCount: x.row_count,
    firstShipDate: x.first_ship_date, lastShipDate: x.last_ship_date }]));
}

// ─── Comparison ───────────────────────────────────────────────────────────────

/** Compare a candidate version with the active data on their overlapping dates. */
export async function compareWithActive(db, { from, to, rows, exportedAt, timeZone }) {
  const segs = await activeSegments(db);
  const cmp = { firstVersion: segs.length === 0, gap: false, overlap: null, trailingFrom: null, possibleIncompleteTrailingDate: false,
                appeared: 0, disappeared: 0, changed: 0, datesLostRows: 0, overlapActiveCents: 0, overlapNewCents: 0, identical: false };
  if (exportedAt && dateIn(exportedAt, timeZone) <= to) cmp.possibleIncompleteTrailingDate = true;   // export taken on/before the last requested day
  if (!segs.length) return cmp;
  const covFrom = segs[0].segFrom, covTo = segs[segs.length - 1].segTo;
  if (from > addDays(covTo, 1) || to < addDays(covFrom, -1)) { cmp.gap = true; return cmp; }
  const ovFrom = from > covFrom ? from : covFrom, ovTo = to < covTo ? to : covTo;
  if (to > covTo) cmp.trailingFrom = addDays(covTo, 1);
  if (ovFrom > ovTo) { cmp.identical = true; return cmp; }                    // adjacent extension, nothing overlaps
  cmp.overlap = { from: ovFrom, to: ovTo };
  const oldRows = await activeRowsInRange(db, ovFrom, ovTo);
  const newRows = rows.filter(r => r.shipDate >= ovFrom && r.shipDate <= ovTo);
  const a = aggregateByOrder(oldRows), b = aggregateByOrder(newRows);
  for (const [k, x] of b) {
    const y = a.get(k);
    if (!y) cmp.appeared++;
    else if (y.costCents !== x.costCents || y.rowCount !== x.rowCount || y.firstShipDate !== x.firstShipDate || y.lastShipDate !== x.lastShipDate) cmp.changed++;
  }
  for (const k of a.keys()) if (!b.has(k)) cmp.disappeared++;
  const oldDates = new Set(oldRows.map(r => r.shipDate)), newDates = new Set(newRows.map(r => r.shipDate));
  for (const d of oldDates) if (!newDates.has(d)) cmp.datesLostRows++;
  cmp.overlapActiveCents = oldRows.reduce((s, r) => s + r.shippingCostCents, 0);
  cmp.overlapNewCents = newRows.reduce((s, r) => s + r.shippingCostCents, 0);
  cmp.identical = cmp.appeared === 0 && cmp.disappeared === 0 && cmp.changed === 0 && cmp.datesLostRows === 0 && cmp.overlapActiveCents === cmp.overlapNewCents;
  return cmp;
}

export function autoAcceptable(cmp, reviewFlags) {
  return !cmp.firstVersion && !cmp.gap && cmp.identical && !cmp.possibleIncompleteTrailingDate && Object.keys(reviewFlags).length === 0;
}

// ─── Activation / rollback ────────────────────────────────────────────────────

/**
 * C3: record which Shopify weeks an activation or rollback changed, as an
 * ingest run (source 'shipping_cost_report') of the cycle week that ends the
 * report's range, so /v1/admin/revise-touched drafts revisions for them.
 */
async function recordTouchedWeeks(db, beforeTotals, cycleEnd, sourceSha256 = null) {
  const afterTotals = await effectiveOrderTotals(db);
  const changed = [];
  for (const k of new Set([...beforeTotals.keys(), ...afterTotals.keys()])) {
    if ((beforeTotals.get(k)?.costCents ?? null) !== (afterTotals.get(k)?.costCents ?? null)) changed.push(k);
  }
  const weeks = {};
  for (const r of await selectIn(db, 'SELECT week_start FROM shopify_order WHERE order_number IN (SELECT value FROM json_each(?1))', changed)) {
    weeks[r.week_start] = (weeks[r.week_start] || 0) + 1;
  }
  const at = nowIso();
  await db.prepare(`INSERT INTO ingest_run (run_id, source, week_start, started_at, finished_at, status, rows_seen, rows_written, duplicates, diagnostics, weeks_touched)
    VALUES (?1, 'shipping_cost_report', ?2, ?3, ?3, 'ok', ?4, ?5, 0, ?6, ?7)`)
    .bind(newId('ing'), weekStartOf(cycleEnd), at, changed.length, changed.length, JSON.stringify({ changedOrders: changed.length, ...(sourceSha256 ? { sanitizedSha256: sourceSha256 } : {}) }), JSON.stringify(weeks)).run();
  await markCyclesChanged(db, [...Object.keys(weeks), weekStartOf(cycleEnd)]);
  return { changedOrders: changed.length, weeksTouched: weeks };
}

async function activate(db, version, actor, reason) {
  const totalsBefore = await effectiveOrderTotals(db);
  const before = await activeSegments(db);
  const n = (await db.prepare('SELECT COUNT(*) AS n FROM shipping_cost_activation').first()).n;
  const activationId = newId('sca');
  const after = replaceRange(before, version.requested_from, version.requested_to, version.version_id, activationId);
  if (!contiguous(after)) throw new ApiError(409, 'segment_gap', 'Accepting this version would leave a gap between active ship-date segments');
  const at = nowIso();
  const stmts = [
    // Abort if another activation happened since `before` was read.
    db.prepare('INSERT INTO write_guard (ok) SELECT NULL WHERE (SELECT COUNT(*) FROM shipping_cost_activation) != ?1').bind(n),
    db.prepare('DELETE FROM shipping_cost_active_segment'),
    ...after.map(s => db.prepare('INSERT INTO shipping_cost_active_segment (seg_from, seg_to, version_id, activation_id) VALUES (?1, ?2, ?3, ?4)')
      .bind(s.segFrom, s.segTo, s.versionId, s.activationId)),
    db.prepare(`INSERT INTO shipping_cost_activation (activation_id, version_id, range_from, range_to, prior_segments, activated_at, actor_class, actor_label, reason)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`).bind(activationId, version.version_id, version.requested_from, version.requested_to,
      JSON.stringify(before), at, actor.cls, actor.label, reason),
    db.prepare(`UPDATE shipping_cost_source_version SET status = 'accepted', decided_at = ?2, decided_by_class = ?3, decided_by_label = ?4, decision_reason = ?5
      WHERE version_id = ?1`).bind(version.version_id, at, actor.cls, actor.label, reason),
  ];
  try { await atomic(db, stmts); }
  catch (e) { if (isGuardAbort(e)) throw new ApiError(409, 'activation_conflict', 'Another activation happened first; nothing was written'); throw e; }
  const touched = await recordTouchedWeeks(db, totalsBefore, version.requested_to, version.sanitized_sha256);
  return { activationId, segments: after, touched };
}

// ─── Ingest ───────────────────────────────────────────────────────────────────

export async function ingestShippingCostReport(request, env) {
  const body = await readJson(request);
  if (body.format !== 'csv_text' || typeof body.text !== 'string' || !body.text.trim()) throw new ApiError(400, 'bad_payload', "Send { format: 'csv_text', text, requestedFrom, requestedTo, rowCount, shippingCostTotal }");
  const sha = await sha256Hex(body.text);
  if (body.sanitizedSha256 !== undefined && body.sanitizedSha256 !== sha) throw new ApiError(400, 'hash_mismatch', 'sanitizedSha256 does not match the payload received');
  const seen = await env.DB.prepare('SELECT version_id, status FROM shipping_cost_source_version WHERE sanitized_sha256 = ?1').bind(sha).first();
  if (seen) return json({ sourceStatus: 'source_no_change', sourceHash: sha, versionId: seen.version_id, status: seen.status });

  const settings = await getSettings(env.DB);
  const actor = actorFor('ingest_secret', body);
  let parsed;
  try {
    parsed = parseShippingCostReport(parseCSV(body.text.replace(/^\uFEFF/, '')),
      { requestedFrom: body.requestedFrom, requestedTo: body.requestedTo, expectedStore: settings.shipping_report_store });
  } catch (e) {
    if (e.code === 'unapproved_columns') throw new ApiError(400, 'customer_data_rejected', 'The upload has columns outside the 15-column Shipping Cost Report contract', { columns: e.columns });
    if (e.code === 'report_invalid') throw new ApiError(400, 'report_invalid', e.message);
    throw e;
  }
  const total = typeof body.shippingCostTotal === 'number' ? Math.round(body.shippingCostTotal * 100) : toCents(body.shippingCostTotal);
  if (body.rowCount !== parsed.rowCount || total !== parsed.shippingCostCents) {
    throw new ApiError(400, 'report_invalid', 'Row count or Shipping Cost total does not match the collector manifest');
  }
  const cmp = await compareWithActive(env.DB, { from: body.requestedFrom, to: body.requestedTo, rows: parsed.rows,
    exportedAt: body.exportedAt || null, timeZone: settings.shipping_report_timezone });
  const auto = autoAcceptable(cmp, parsed.reviewFlags);

  const versionId = newId('scv');
  const at = nowIso();
  const hashes = await Promise.all(parsed.rows.map(r => contentHash([r.shipDateRaw, r.orderKey, r.provider, r.service, r.package, r.items, r.zone,
    r.shippingCostCents, r.insuranceCents, r.dutiesCents, r.taxesCents, r.importFeeCents, r.weight, r.weightUnit, r.store])));
  const rows = parsed.rows.map((r, i) => ({ version_id: versionId, row_seq: r.rowSeq, ship_date_raw: r.shipDateRaw, ship_date: r.shipDate,
    order_key: r.orderKey, provider: r.provider, service: r.service, package: r.package, items: r.items, zone: r.zone,
    shipping_cost_cents: r.shippingCostCents, insurance_cents: r.insuranceCents, duties_cents: r.dutiesCents, taxes_cents: r.taxesCents,
    import_fee_cents: r.importFeeCents, weight: r.weight, weight_unit: r.weightUnit, store: r.store, row_hash: hashes[i] }));
  const aggs = [...aggregateByOrder(parsed.rows).values()].map(a => ({ version_id: versionId, order_key: a.orderKey, cost_cents: a.costCents,
    row_count: a.rowCount, first_ship_date: a.firstShipDate, last_ship_date: a.lastShipDate }));
  await atomic(env.DB, [
    env.DB.prepare(`INSERT INTO shipping_cost_source_version (version_id, requested_from, requested_to, exported_at, imported_at, sanitized_sha256,
        row_count, cost_total_cents, first_ship_date, last_ship_date, schema_version, report_currency, report_timezone, status, review_flags,
        comparison, imported_by_class, imported_by_label) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'pending_review', ?14, ?15, ?16, ?17)`)
      .bind(versionId, body.requestedFrom, body.requestedTo, body.exportedAt || null, at, sha, parsed.rowCount, parsed.shippingCostCents,
        parsed.firstShipDate, parsed.lastShipDate, SCHEMA_VERSION, settings.shipping_report_currency, settings.shipping_report_timezone,
        JSON.stringify(parsed.reviewFlags), JSON.stringify(cmp), actor.cls, actor.label),
    ...jsonInsert(env.DB, 'shipping_cost_row', ROW_COLS, rows, { replace: false }),
    ...jsonInsert(env.DB, 'shipping_cost_order_agg', AGG_COLS, aggs, { replace: false }),
  ]);
  let activation = null;
  if (auto) {
    const v = await env.DB.prepare('SELECT * FROM shipping_cost_source_version WHERE version_id = ?1').bind(versionId).first();
    activation = await activate(env.DB, v, { cls: 'worker', label: 'shipping-cost:auto-accept' }, 'overlap reconciles exactly; no review flags');
  }
  await markCyclesChanged(env.DB, weeksInRange(body.requestedFrom, body.requestedTo));
  return json({ sourceStatus: 'source_received', sourceHash: sha, versionId, status: auto ? 'accepted' : 'pending_review',
    rowCount: parsed.rowCount, shippingCostTotal: fromCents(parsed.shippingCostCents), orderCount: aggs.length,
    reviewFlags: parsed.reviewFlags, comparison: cmp, activationId: activation?.activationId || null, ...actorJson(actor) });
}

// ─── Admin ────────────────────────────────────────────────────────────────────

const versionJson = v => v && ({
  versionId: v.version_id, status: v.status, requestedFrom: v.requested_from, requestedTo: v.requested_to, exportedAt: v.exported_at,
  importedAt: v.imported_at, rowCount: v.row_count, shippingCostTotal: fromCents(v.cost_total_cents), firstShipDate: v.first_ship_date,
  lastShipDate: v.last_ship_date, schemaVersion: v.schema_version, reportCurrency: v.report_currency, reportTimezone: v.report_timezone,
  reviewFlags: JSON.parse(v.review_flags || '{}'), comparison: JSON.parse(v.comparison || '{}'),
  decidedAt: v.decided_at, decidedByClass: v.decided_by_class, decisionReason: v.decision_reason,
});

export async function listVersions(env) {
  const r = await env.DB.prepare('SELECT * FROM shipping_cost_source_version ORDER BY imported_at DESC LIMIT 100').all();
  return json({ versions: (r.results || []).map(versionJson) });
}
export async function getVersion(env, id) {
  const v = await env.DB.prepare('SELECT * FROM shipping_cost_source_version WHERE version_id = ?1').bind(id).first();
  if (!v) throw new ApiError(404, 'not_found', 'No such shipping-cost version');
  return json({ version: versionJson(v) });
}
export async function acceptVersion(request, env, id) {
  const body = await readJson(request);
  const reason = reasonOrThrow(body.reason, 'Accepting a shipping-cost version');
  const v = await env.DB.prepare('SELECT * FROM shipping_cost_source_version WHERE version_id = ?1').bind(id).first();
  if (!v) throw new ApiError(404, 'not_found', 'No such shipping-cost version');
  if (v.status !== 'pending_review') throw new ApiError(409, 'not_pending', `Version is ${v.status}`);
  const r = await activate(env.DB, v, actorFor('admin_secret', body), reason);
  return json({ versionId: id, status: 'accepted', activationId: r.activationId, segments: r.segments });
}
export async function rejectVersion(request, env, id) {
  const body = await readJson(request);
  const reason = reasonOrThrow(body.reason, 'Rejecting a shipping-cost version');
  const actor = actorFor('admin_secret', body);
  const u = await env.DB.prepare(`UPDATE shipping_cost_source_version SET status = 'rejected', decided_at = ?2, decided_by_class = ?3, decided_by_label = ?4,
      decision_reason = ?5 WHERE version_id = ?1 AND status = 'pending_review'`).bind(id, nowIso(), actor.cls, actor.label, reason).run();
  if (u.meta.changes !== 1) throw new ApiError(409, 'not_pending', 'Only a pending_review version can be rejected');
  // C8: a waiting week re-evaluates its report basis; a draft labelled "newer
  // report pending review" is revised by the tick (the label no longer applies).
  const v = await env.DB.prepare('SELECT requested_from, requested_to FROM shipping_cost_source_version WHERE version_id = ?1').bind(id).first();
  if (v) await markCyclesChanged(env.DB, weeksInRange(v.requested_from, v.requested_to));
  return json({ versionId: id, status: 'rejected' });
}
export async function rollbackActivation(request, env, activationId) {
  const body = await readJson(request);
  const reason = reasonOrThrow(body.reason, 'Rolling back a shipping-cost activation');
  const actor = actorFor('admin_secret', body);
  const latest = await env.DB.prepare('SELECT * FROM shipping_cost_activation WHERE rolled_back_at IS NULL ORDER BY activated_at DESC, rowid DESC LIMIT 1').first();
  if (!latest || latest.activation_id !== activationId) throw new ApiError(409, 'not_latest', 'Only the latest activation can be rolled back');
  const prior = JSON.parse(latest.prior_segments);
  const at = nowIso();
  const totalsBefore = await effectiveOrderTotals(env.DB);
  await atomic(env.DB, [
    env.DB.prepare('DELETE FROM shipping_cost_active_segment'),
    ...prior.map(s => env.DB.prepare('INSERT INTO shipping_cost_active_segment (seg_from, seg_to, version_id, activation_id) VALUES (?1, ?2, ?3, ?4)')
      .bind(s.segFrom, s.segTo, s.versionId, s.activationId)),
    env.DB.prepare(`UPDATE shipping_cost_activation SET rolled_back_at = ?2, rolled_back_by_class = ?3, rolled_back_by_label = ?4, rollback_reason = ?5
      WHERE activation_id = ?1`).bind(activationId, at, actor.cls, actor.label, reason),
    env.DB.prepare(`UPDATE shipping_cost_source_version SET status = 'rolled_back' WHERE version_id = ?1`).bind(latest.version_id),
  ]);
  const rolled = await env.DB.prepare('SELECT sanitized_sha256 FROM shipping_cost_source_version WHERE version_id = ?1').bind(latest.version_id).first();
  const touched = await recordTouchedWeeks(env.DB, totalsBefore, latest.range_to, rolled?.sanitized_sha256 || null);
  return json({ activationId, rolledBack: true, segments: prior, touched });
}
export async function getSegments(env) { return json({ segments: await activeSegments(env.DB) }); }
export async function getEffectiveSummary(env) {
  const t = await effectiveOrderTotals(env.DB);
  let cents = 0, rows = 0, multi = 0;
  for (const a of t.values()) { cents += a.costCents; rows += a.rowCount; if (a.rowCount > 1) multi++; }
  return json({ orders: t.size, rows, ordersWithMultipleRows: multi, shippingCostTotal: fromCents(cents), segments: await activeSegments(env.DB) });
}

/** Monday week starts overlapping [from, to]. */
function weeksInRange(from, to) {
  const out = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(from)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(to))) return out;
  for (let w = weekStartOf(from); w <= to && out.length < 60; w = addDays(w, 7)) out.push(w);
  return out;
}
