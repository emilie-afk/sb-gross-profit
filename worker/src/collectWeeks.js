/**
 * collectWeeks.js — orders, pinned week manifests and collector-computed results (Free-tier path)
 * ================================================================================================
 * Orders (X-Ingest-Secret)
 *   POST /v1/collect/orders/diff            { orders: [[orderName, bodyHash]] } → which pointers / bodies are needed
 *   POST /v1/collect/orders                 { sourceId, orders: [{ s, h }] } ≤ 10 canonical stored-form orders
 * Pinned inputs (X-Ingest-Secret or X-Verify-Secret; read-only)
 *   GET  /v1/collect/weeks/:week/manifest   the Worker-authored manifest + its hash + the Worker's signature
 *   POST /v1/collect/order-bodies           { hashes } ≤ 200 → canonical bodies
 *   GET  /v1/collect/catalog/:rev/parts/:table/:part   one catalog part (text)
 *   GET  /v1/collect/weeks/:week/aux        the week's ShipStation mapping rows and HPD records, as the loaders return them
 * Results (X-Ingest-Secret)
 *   POST /v1/collect/weeks/:week/results    { manifest, manifestHash, signature, index } → snapshot id + missing parts
 *   PUT  /v1/collect/results/:id/parts/:name  one gzip part
 *   POST /v1/collect/results/:id/finalize   inputs still current → gate → run + snapshot rows (storage 'chunked')
 *
 * The Worker never computes a week on this path. It pins exactly what its own
 * loaders would feed the engine (orders, Shipping Cost Report dates in force,
 * catalog, settings, prior-week comparison, report basis), checks at finalize
 * that nothing changed since, and stores the collector's result parts. Every
 * such draft stays labelled provisional until the independent verifier has
 * recomputed it and matched every order and aggregate (verifyRoutes.js).
 */
import { ApiError, json, readJson, WEEK_RE } from './http.js';
import { newId, nowIso, getSettings, selectIn, atomic } from './db.js';
import { signManifest, manifestSignatureValid } from './auth.js';
import { readBytes, gunzipCapped, sha256Text, HEX64 } from './gz.js';
import { loadShipmentsForOrders, loadHpdForOrders, catalogMeta } from './store.js';
import { chooseCatalog, catalogFreshness, previousWeekSnapshots, sourceStatus } from './compute.js';
import { createRunStatements } from './runs.js';
import { scrBasis } from './collectScr.js';
import { ENGINE_VERSION } from '../../shared/snapshot.js';
import { evaluateGate } from '../../shared/gate.js';
import { stableStringify, weekStartOf, assertNoCustomerFields, addDays, CustomerDataError } from '../../shared/normalized.js';
import { assertReducedNormalizedOrders } from '../../shared/adapters/shopifyPrivacy.js';
import { storedOrderForm, MANIFEST_VERSION, auxHash } from '../../shared/bundle.js';
import { ORDER_COLUMNS, LINE_COLUMNS, BREAKDOWN_COLUMNS, ISSUE_COLUMNS, RECON_COLUMNS, TOTALS_COLUMNS } from '../../shared/resultParts.js';
import { weekWindowUtc } from '../../shared/schedule.js';

const P = (s, d = null) => { try { return JSON.parse(s); } catch { return d; } };
const J = v => JSON.stringify(v ?? null);
const COLLECTOR = Object.freeze({ cls: 'ingest_secret', label: 'collector' });
export const ORDERS_PER_CHUNK = 10;
export const PART_LIMITS = Object.freeze({ compressed: 256 * 1024, decompressed: 1536 * 1024, ratio: 60 });
export const MANIFEST_MAX_AGE_MS = 6 * 3600_000;

// ─── Orders ──────────────────────────────────────────────────────────────────

export async function ordersDiff(request, env) {
  const b = await readJson(request);
  const list = Array.isArray(b.orders) ? b.orders : [];
  if (list.length > 3000 || list.some(x => !Array.isArray(x) || typeof x[0] !== 'string' || !HEX64.test(x[1] || ''))) throw new ApiError(400, 'bad_payload', 'orders: ≤ 3000 [orderName, bodyHash] pairs');
  const ptr = new Map((await selectIn(env.DB, 'SELECT order_name, body_hash FROM ord_ptr WHERE order_name IN (SELECT value FROM json_each(?1))', list.map(x => x[0])))
    .map(r => [r.order_name, r.body_hash]));
  const stale = list.filter(([n, h]) => ptr.get(n) !== h);
  const have = new Set((await selectIn(env.DB, 'SELECT body_hash FROM ord_body WHERE body_hash IN (SELECT value FROM json_each(?1))', [...new Set(stale.map(x => x[1]))])).map(r => r.body_hash));
  return json({ needPointer: stale.map(x => x[0]), needBody: [...new Set(stale.map(x => x[1]).filter(h => !have.has(h)))] });
}

export async function uploadOrders(request, env) {
  const b = await readJson(request);
  const db = env.DB;
  const list = Array.isArray(b.orders) ? b.orders : [];
  if (!list.length || list.length > ORDERS_PER_CHUNK) throw new ApiError(400, 'bad_payload', `1–${ORDERS_PER_CHUNK} orders per request`);
  const src = await db.prepare("SELECT status FROM src_object WHERE source_id = ?1 AND kind = 'shopify'").bind(String(b.sourceId || '')).first();
  if (src?.status !== 'retained') throw new ApiError(409, 'source_not_retained', 'Orders must come from a retained sanitized Shopify source');
  const settings = await getSettings(db);
  const orders = [];
  for (const x of list) {
    if (typeof x?.s !== 'string' || !HEX64.test(x.h || '')) throw new ApiError(400, 'bad_payload', 'Each order is { s: canonical string, h: sha256 }');
    if (await sha256Text(x.s) !== x.h) throw new ApiError(400, 'hash_mismatch', 'An order does not match its hash');
    const o = P(x.s);
    if (!o || typeof o.orderName !== 'string' || !o.businessDate || !Array.isArray(o.lines)) throw new ApiError(400, 'bad_payload', 'An order is missing orderName, businessDate or lines');
    orders.push({ o, s: x.s, h: x.h });
  }
  try {
    assertNoCustomerFields(orders.map(x => x.o));           // customer fields → rejected, not dropped
    assertReducedNormalizedOrders(orders.map(x => x.o));    // same privacy contract as the csv_text route
  } catch (e) {
    if (e instanceof CustomerDataError) throw new ApiError(400, 'customer_data_rejected', 'Payload contains customer fields');
    throw new ApiError(400, e.code || 'bad_payload', 'An order failed the privacy contract');
  }
  for (const x of orders) if (stableStringify(storedOrderForm(x.o)) !== x.s) throw new ApiError(400, 'not_canonical', 'An order is not in canonical stored form');
  const prev = new Map((await selectIn(db, 'SELECT order_name, body_hash, week_start FROM ord_ptr WHERE order_name IN (SELECT value FROM json_each(?1))', orders.map(x => x.o.orderName)))
    .map(r => [r.order_name, r]));
  const changed = orders.filter(x => prev.get(x.o.orderName)?.body_hash !== x.h);
  const at = nowIso(), weeksTouched = {};
  const stmts = [];
  for (const x of changed) {
    const week = weekStartOf(x.o.businessDate);
    weeksTouched[week] = (weeksTouched[week] || 0) + 1;
    const old = prev.get(x.o.orderName)?.week_start;
    if (old && old !== week) weeksTouched[old] = (weeksTouched[old] || 0) + 1;
    stmts.push(db.prepare('INSERT OR IGNORE INTO ord_body (body_hash, body) VALUES (?1, ?2)').bind(x.h, x.s));
    stmts.push(db.prepare(`INSERT INTO ord_ptr (order_name, order_number, week_start, body_hash, source_id, timezone, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT(order_name) DO UPDATE SET order_number = excluded.order_number, week_start = excluded.week_start, body_hash = excluded.body_hash,
        source_id = excluded.source_id, timezone = excluded.timezone, updated_at = excluded.updated_at WHERE ord_ptr.body_hash <> excluded.body_hash`)
      .bind(x.o.orderName, String(x.o.orderNumber || ''), week, x.h, b.sourceId, settings.store_timezone, at));
  }
  if (stmts.length) await atomic(db, stmts);
  return json({ written: changed.length, duplicates: orders.length - changed.length, weeksTouched });
}

// ─── Manifest ────────────────────────────────────────────────────────────────

const capturedAt = async (db, rev) => rev ? (await db.prepare('SELECT captured_at FROM cost_catalog WHERE catalog_rev = ?1').bind(rev).first())?.captured_at || null : null;

/** The week's pinned inputs, exactly what the Worker's own loaders would give the engine now. */
export async function assembleManifest(env, weekStart) {
  if (!WEEK_RE.test(weekStart) || weekStartOf(weekStart) !== weekStart) throw new ApiError(400, 'bad_query', 'week must be a Monday (YYYY-MM-DD)');
  const db = env.DB;
  const settings = await getSettings(db);
  const closedAt = weekWindowUtc(weekStart, settings.store_timezone).endUtcExclusive;
  const basis = await scrBasis(db, weekStart, closedAt);
  if (basis.basisStatus !== 'ok') throw new ApiError(409, 'shipping_report_not_ready', `No snapshot: the week's Shipping Cost Report is ${basis.basisStatus} (${basis.label})`, { shippingReport: basis.basisStatus });
  const info = await chooseCatalog(db, weekStart);
  if (!info.rev) throw new ApiError(409, 'no_catalog', 'No accepted cost catalog; push one before computing');
  info.capturedAt = await capturedAt(db, info.rev);
  const orders = (await db.prepare('SELECT order_name, order_number, body_hash, source_id FROM ord_ptr WHERE week_start = ?1 ORDER BY order_name').bind(weekStart).all()).results || [];
  if (!orders.length) throw new ApiError(409, 'week_empty', `No orders stored for the week of ${weekStart}`);
  const nums = [...new Set(orders.map(o => o.order_number))];
  const [shipments, hpdOrders] = [await loadShipmentsForOrders(db, nums), await loadHpdForOrders(db, nums)];
  // Shipping Cost Report dates the week depends on: its own seven dates, and every owned date that
  // holds cost for one of its orders or for an order shipped in the week (that order's first ship
  // date decides the unmatched count). Other dates cannot change this week's figures, so they are
  // not pinned. The search over the stored groups runs in D1 (json_each), not in Worker CPU.
  const weekEnd = addDays(weekStart, 6);
  const weekOwned = (await db.prepare('SELECT ship_date, version_id, day_hash FROM scr_day_owner WHERE ship_date BETWEEN ?1 AND ?2 ORDER BY ship_date').bind(weekStart, weekEnd).all()).results || [];
  const weekDays = weekOwned.length ? await selectIn(db, `SELECT d.groups FROM scr_day d JOIN json_each(?1) j ON d.version_id = json_extract(j.value, '$[0]') AND d.ship_date = json_extract(j.value, '$[1]')`,
    weekOwned.map(o => [o.version_id, o.ship_date])) : [];
  const weekKeys = [...new Set(weekDays.flatMap(r => (P(r.groups, []) || []).map(g => g[0])))];
  const keys = [...new Set([...nums.map(n => String(n).replace(/^#/, '')), ...weekKeys])];
  const related = keys.length ? await selectIn(db, `SELECT DISTINCT o.ship_date, o.version_id, o.day_hash FROM scr_day_owner o
      JOIN scr_day d ON d.version_id = o.version_id AND d.ship_date = o.ship_date, json_each(d.groups) g
      WHERE json_extract(g.value, '$[0]') IN (SELECT value FROM json_each(?1))`, keys) : [];
  const owners = [...new Map([...weekOwned, ...related].map(o => [o.ship_date, o])).values()].sort((a, b) => (a.ship_date < b.ship_date ? -1 : 1));
  const vids = [...new Set(owners.map(o => o.version_id))];
  const versions = vids.length ? await selectIn(db, 'SELECT version_id, source_id, requested_from, requested_to FROM scr_version WHERE version_id IN (SELECT value FROM json_each(?1)) ORDER BY version_id', vids) : [];
  const known = weekKeys.length ? (await selectIn(db, 'SELECT DISTINCT order_number FROM ord_ptr WHERE order_number IN (SELECT value FROM json_each(?1))', weekKeys)).map(r => r.order_number).sort() : [];
  const prev = await previousWeekSnapshots(db, weekStart);
  const last = await db.prepare('SELECT t.shipping_expense AS e FROM snapshot s JOIN snapshot_totals t ON t.snapshot_id = s.snapshot_id WHERE s.week_start = ?1 ORDER BY s.revision DESC LIMIT 1').bind(weekStart).first();
  const parts = ((await db.prepare('SELECT table_name, part FROM cost_catalog_part WHERE catalog_rev = ?1 ORDER BY table_name, part').bind(info.rev).all()).results || []).map(p => [p.table_name, p.part]);
  return {
    v: MANIFEST_VERSION, weekStart, engineVersion: ENGINE_VERSION, asOf: nowIso(), storeTimezone: settings.store_timezone, settings,
    catalog: { rev: info.rev, info, completeness: (await catalogMeta(db, info.rev))?.meta?.completeness || null, parts },
    orders: orders.map(o => [o.order_name, o.body_hash, o.source_id]),
    scrDays: owners.map(o => [o.ship_date, o.version_id, o.day_hash]),
    scrVersions: versions.map(v => [v.version_id, v.source_id, v.requested_from, v.requested_to]),
    knownReportKeys: known,
    aux: { shipmentsHash: await auxHash(shipments), hpdHash: await auxHash(hpdOrders), shipments: shipments.length, hpdOrders: hpdOrders.length },
    previous: prev.published, previousDraft: prev.draft, previousShippingExpense: last ? last.e : null,
    shippingReportBasis: basis, publicationAllowedEnv: env.PUBLICATION_ALLOWED === 'true',
  };
}
const withoutAsOf = ({ asOf: _a, ...m }) => m;

/**
 * Hash of the week's inputs alone: equal means nothing the week is computed from has
 * changed, so a recompute would only restate the same figures. Leaves out the issue
 * time, the catalog-selection record (which revision a recompute inherits the catalog
 * from; the catalog revision itself stays in), the week's own previous expense
 * (present only because a revision already exists) and the prior week's unpublished
 * draft (it feeds only the admin draft-comparison preview, never a figure), so one
 * week's revision does not cascade into new revisions of every later week.
 */
export const inputsHashOf = ({ asOf: _a, previousShippingExpense: _p, previousDraft: _d, catalog: { info: _i, ...catalog }, ...m }) => sha256Text(stableStringify({ ...m, catalog }));

export async function getManifest(env, weekStart) {
  const manifest = await assembleManifest(env, weekStart);
  const manifestHash = await sha256Text(stableStringify(manifest));
  // The week's newest revision was computed from exactly these inputs: nothing to do (a retry or re-run writes 0 rows).
  const latest = await env.DB.prepare('SELECT snapshot_id, revision, status, storage, manifest_hash FROM snapshot WHERE week_start = ?1 ORDER BY revision DESC LIMIT 1').bind(weekStart).first();
  const existing = latest?.storage === 'chunked' && latest.manifest_hash === await inputsHashOf(manifest)
    ? { snapshotId: latest.snapshot_id, revision: latest.revision, status: latest.status } : null;
  return json({ manifest, manifestHash, signature: await signManifest(env, manifestHash), existing });
}

export async function orderBodies(request, env) {
  const b = await readJson(request);
  const hashes = Array.isArray(b.hashes) ? b.hashes : [];
  if (hashes.length > 200 || hashes.some(h => !HEX64.test(h))) throw new ApiError(400, 'bad_payload', 'hashes: ≤ 200 sha256 values');
  const rows = hashes.length ? await selectIn(env.DB, 'SELECT body_hash, body FROM ord_body WHERE body_hash IN (SELECT value FROM json_each(?1))', hashes) : [];
  return json({ bodies: rows.map(r => [r.body_hash, r.body]) });
}

export async function catalogPart(env, rev, table, part) {
  const r = await env.DB.prepare(`SELECT p.payload FROM cost_catalog_part p JOIN cost_catalog c ON c.catalog_rev = p.catalog_rev
      WHERE p.catalog_rev = ?1 AND p.table_name = ?2 AND p.part = ?3 AND c.status IN ('accepted','base')`).bind(rev, table, Number(part)).first();
  if (!r) throw new ApiError(404, 'catalog_part_unknown', 'No such catalog part');
  return new Response(r.payload, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

export async function weekAux(env, weekStart) {
  if (!WEEK_RE.test(weekStart)) throw new ApiError(400, 'bad_query', 'week must be YYYY-MM-DD');
  const nums = [...new Set(((await env.DB.prepare('SELECT order_number FROM ord_ptr WHERE week_start = ?1 ORDER BY order_name').bind(weekStart).all()).results || []).map(r => r.order_number))];
  return json({ shipments: await loadShipmentsForOrders(env.DB, nums), hpdOrders: await loadHpdForOrders(env.DB, nums) });
}

// ─── Results ─────────────────────────────────────────────────────────────────

const PART_NAME = /^(summary|sections|scenario|lines:\d{1,4})$/;
const keysOf = cols => new Set(cols.map(c => c[0]));
const ORDER_KEYS = keysOf(ORDER_COLUMNS), LINE_KEYS = keysOf(LINE_COLUMNS), BD_KEYS = keysOf(BREAKDOWN_COLUMNS),
      ISSUE_KEYS = keysOf(ISSUE_COLUMNS), RECON_KEYS = keysOf(RECON_COLUMNS);
const SCENARIO_KEYS = new Set(['orderNum', 'date', 'sku', 'product', 'vendor', 'vendorKey', 'qty', 'unitPrice', 'baseMerchRevenue', 'lineRevenue',
  'lineCogs', 'missingCost', 'costSource', 'isRoute', 'isGiftCard', 'isInfluencerSample', 'shipCollected', 'shipPaid']);
const HEAD_KEYS = ['engine_version', 'catalog_rev', 'policy', 'profitability_status', 'comparison_snapshot_id', 'draft_comparison'];

function rowsExactly(rows, keys, what) {
  if (!Array.isArray(rows)) throw new ApiError(400, 'part_invalid', `${what} must be an array`);
  for (const r of rows) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new ApiError(400, 'part_invalid', `${what} rows must be objects`);
    const k = Object.keys(r);
    if (k.length !== keys.size || k.some(x => !keys.has(x))) throw new ApiError(400, 'part_invalid', `${what} rows must have exactly the approved columns`);
  }
}
function validatePart(name, v) {
  if (!v || typeof v !== 'object') throw new ApiError(400, 'part_invalid', 'Part must be a JSON object');
  if (name === 'summary') {
    rowsExactly(v.orders, ORDER_KEYS, 'summary.orders');
    if (!v.part || typeof v.part !== 'object' || Object.values(v.part).some(n => !Number.isInteger(n) || n < 0)) throw new ApiError(400, 'part_invalid', 'summary.part must map orders to line parts');
  } else if (name === 'sections') {
    rowsExactly(v.breakdowns, BD_KEYS, 'breakdowns'); rowsExactly(v.reconciliation, RECON_KEYS, 'reconciliation'); rowsExactly(v.issues, ISSUE_KEYS, 'issues');
  } else if (name === 'scenario') {
    rowsExactly(v.lines, SCENARIO_KEYS, 'scenario.lines');
  } else rowsExactly(v.lines, LINE_KEYS, 'lines');
  try { assertNoCustomerFields(v); } catch { throw new ApiError(400, 'customer_data_rejected', 'A result part contains customer fields'); }
}

export async function openResults(request, env, weekStart) {
  const b = await readJson(request);
  const { manifest, manifestHash, signature, index } = b;
  if (!manifest || manifest.weekStart !== weekStart) throw new ApiError(400, 'bad_payload', 'manifest for this week is required');
  if (await sha256Text(stableStringify(manifest)) !== manifestHash) throw new ApiError(400, 'hash_mismatch', 'manifestHash does not match the manifest');
  if (!(await manifestSignatureValid(env, manifestHash, signature))) throw new ApiError(403, 'manifest_not_issued', 'This manifest was not issued by this Worker');
  if (Date.now() - Date.parse(manifest.asOf) > MANIFEST_MAX_AGE_MS) throw new ApiError(409, 'manifest_expired', 'The manifest is older than 6 hours; fetch a new one');
  if (manifest.engineVersion !== ENGINE_VERSION || index?.engineVersion !== ENGINE_VERSION) throw new ApiError(409, 'engine_version_mismatch', `This Worker accepts results of engine ${ENGINE_VERSION} only`);
  const names = Object.keys(index?.parts || {});
  if (!names.includes('summary') || !names.includes('sections') || !names.includes('scenario') || names.some(n => !PART_NAME.test(n) || !HEX64.test(index.parts[n]))) throw new ApiError(400, 'bad_payload', 'index.parts must name summary, sections, scenario and lines:k with sha256 values');
  const lineParts = names.filter(n => n.startsWith('lines:')).map(n => Number(n.slice(6))).sort((a, c) => a - c);
  if (lineParts.some((k, i) => k !== i)) throw new ApiError(400, 'bad_payload', 'line parts must be numbered 0…n−1');
  if (!Array.isArray(index.orders) || index.orders.some(x => !Array.isArray(x) || typeof x[0] !== 'string' || !HEX64.test(x[1] || ''))) throw new ApiError(400, 'bad_payload', 'index.orders must be [[orderName, sha256]]');
  const head = index.head || {};
  if (Object.keys(head).sort().join() !== [...HEAD_KEYS].sort().join()) throw new ApiError(400, 'bad_payload', 'index.head has unexpected fields');
  if (head.engine_version !== ENGINE_VERSION || head.catalog_rev !== manifest.catalog.rev) throw new ApiError(400, 'bad_payload', 'index.head does not match the manifest');
  const totals = P(index.totals);
  if (!totals || Object.keys(totals).length !== TOTALS_COLUMNS.length || TOTALS_COLUMNS.some(([c]) => !(c in totals))) throw new ApiError(400, 'bad_payload', 'index.totals must be the totals row');
  if (totals.profitability_status !== head.profitability_status) throw new ApiError(400, 'bad_payload', 'index.totals and index.head disagree');
  if (typeof index.narrative !== 'string' || P(index.narrative) === null) throw new ApiError(400, 'bad_payload', 'index.narrative must be the canonical narrative');
  const gi = index.gateInputs || {};
  if (!gi.totals || !Array.isArray(gi.reconciliation)) throw new ApiError(400, 'bad_payload', 'index.gateInputs is required');
  try { assertNoCustomerFields([head, totals, P(index.narrative), gi]); } catch { throw new ApiError(400, 'customer_data_rejected', 'The result index contains customer fields'); }
  const idx = J(index);
  const db = env.DB;
  const same = await db.prepare("SELECT snapshot_id FROM result_upload WHERE week_start = ?1 AND manifest_hash = ?2 AND status = 'open' AND idx = ?3").bind(weekStart, manifestHash, idx).first();
  const snapshotId = same?.snapshot_id || newId('snp');
  if (!same) {
    await db.prepare('INSERT INTO result_upload (snapshot_id, week_start, manifest_hash, engine_version, idx, manifest, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
      .bind(snapshotId, weekStart, manifestHash, ENGINE_VERSION, idx, J(manifest), 'open', nowIso()).run();
  }
  const have = new Set(((await db.prepare('SELECT part FROM snapshot_blob WHERE snapshot_id = ?1').bind(snapshotId).all()).results || []).map(r => r.part));
  return json({ snapshotId, missing: names.filter(n => !have.has(n)) });
}

async function openUpload(db, id) {
  const u = await db.prepare('SELECT * FROM result_upload WHERE snapshot_id = ?1').bind(id).first();
  if (!u) throw new ApiError(404, 'upload_unknown', 'No such result upload');
  return u;
}

export async function putResultPart(request, env, id, name) {
  const db = env.DB;
  const u = await openUpload(db, id);
  if (u.status !== 'open') throw new ApiError(409, 'upload_closed', `This upload is ${u.status}`);
  const want = P(u.idx, {}).parts?.[name];
  if (!want) throw new ApiError(400, 'bad_payload', 'No such part in the index');
  const bytes = await readBytes(request, PART_LIMITS.compressed);
  const text = await gunzipCapped(bytes, Math.min(PART_LIMITS.decompressed, bytes.byteLength * PART_LIMITS.ratio));
  if (await sha256Text(text) !== want) throw new ApiError(400, 'hash_mismatch', 'Part does not match its indexed hash');
  const v = P(text);
  validatePart(name, v);
  if (stableStringify(v) !== text) throw new ApiError(400, 'not_canonical', 'Part is not canonical JSON');
  await db.prepare('INSERT OR IGNORE INTO snapshot_blob (snapshot_id, part, sha256, body) VALUES (?1, ?2, ?3, ?4)').bind(id, name, want, bytes).run();
  return json({ snapshotId: id, part: name, status: 'stored' });
}

const transitionStmt = (db, runId, from, to, at, actor, note) =>
  db.prepare(`INSERT INTO run_transition (run_id, seq, from_state, to_state, at, actor_class, actor_label, note)
    SELECT ?1, (SELECT COALESCE(MAX(seq), -1) + 1 FROM run_transition WHERE run_id = ?1), ?2, ?3, ?4, ?5, ?6, ?7`).bind(runId, from, to, at, actor.cls, actor.label, note);
const guard = (db, cond, ...params) => db.prepare(`INSERT INTO write_guard (ok) SELECT NULL WHERE NOT (${cond})`).bind(...params);

export async function finalizeResults(request, env, id) {
  const db = env.DB;
  const u = await openUpload(db, id);
  if (u.status === 'finalized') {
    const s = await db.prepare('SELECT revision, status FROM snapshot WHERE snapshot_id = ?1').bind(id).first();
    return json({ snapshotId: id, revision: s?.revision, status: s?.status, verification: 'pending', already: true });
  }
  if (u.status !== 'open') throw new ApiError(409, 'upload_closed', `This upload is ${u.status}`);
  const index = P(u.idx, {}), pinned = P(u.manifest, {});
  const names = Object.keys(index.parts);
  const have = new Set(((await db.prepare('SELECT part FROM snapshot_blob WHERE snapshot_id = ?1').bind(id).all()).results || []).map(r => r.part));
  const missing = names.filter(n => !have.has(n));
  if (missing.length) throw new ApiError(409, 'parts_missing', `${missing.length} part(s) not uploaded yet`, { missing });
  // Inputs must be exactly what the manifest pinned: otherwise the result is for a stale week.
  let current;
  try { current = await assembleManifest(env, u.week_start); }
  catch (e) { if (e instanceof ApiError) { await db.prepare("UPDATE result_upload SET status = 'abandoned' WHERE snapshot_id = ?1").bind(id).run(); } throw e; }
  if (stableStringify(withoutAsOf(current)) !== stableStringify(withoutAsOf(pinned))) {
    await db.prepare("UPDATE result_upload SET status = 'abandoned' WHERE snapshot_id = ?1 AND status = 'open'").bind(id).run();
    throw new ApiError(409, 'inputs_changed', "The week's inputs changed after the manifest was issued; fetch a new manifest and recompute");
  }
  const settings = pinned.settings, info = pinned.catalog.info, basis = pinned.shippingReportBasis;
  const runId = newId('run'), at = nowIso();
  const freshness = await catalogFreshness(db, runId, info);
  const catalogInfo = { ...info, freshness };
  const hpdStatus = (await sourceStatus(db, u.week_start, { orders: pinned.orders, shipments: [], hpd: new Array(pinned.aux.hpdOrders).fill(0) })).hpd;
  const sources = { shopify: 'ok', shipstation: 'ok', hpd: hpdStatus };
  const ordersInOtherTimezone = (await db.prepare('SELECT COUNT(*) AS n FROM ord_ptr WHERE week_start = ?1 AND timezone <> ?2').bind(u.week_start, settings.store_timezone).first())?.n || 0;
  const gi = index.gateInputs;
  const gate = evaluateGate({ totals: gi.totals, reconciliation: gi.reconciliation, sources, catalog: { accepted: true, rev: info.rev, freshness },
                              settings, ordersInOtherTimezone, shippingC3: gi.shippingC3, shippingReport: basis });
  const gateRecord = { ...gate, sources, shippingReport: basis, storeTimezone: settings.store_timezone, storeTimezoneConfirmed: settings.store_timezone_confirmed === true,
    catalog: { expectedRefreshId: info.refreshId || null, selectedRev: info.rev, capturedAt: info.capturedAt, basis: info.basis, freshness },
    computedBy: 'collector', verification: 'pending' };
  const revision = ((await db.prepare('SELECT MAX(revision) AS m FROM snapshot WHERE week_start = ?1').bind(u.week_start).first())?.m || 0) + 1;
  const status = gate.passed ? 'draft' : 'blocked', finalState = gate.passed ? 'validated' : 'blocked';
  const head = index.head, totals = P(index.totals);
  const tcols = TOTALS_COLUMNS.map(c => c[0]);
  const stmts = [
    guard(db, "EXISTS (SELECT 1 FROM result_upload WHERE snapshot_id = ?1 AND status = 'open') AND NOT EXISTS (SELECT 1 FROM snapshot WHERE snapshot_id = ?1)", id),
    ...createRunStatements(db, runId, u.week_start, 'collector', COLLECTOR, 'collector-computed week', at),
    transitionStmt(db, runId, 'created', 'computing', at, COLLECTOR, null),
    transitionStmt(db, runId, 'computing', 'draft', at, COLLECTOR, null),
    transitionStmt(db, runId, 'draft', finalState, at, COLLECTOR, gate.passed ? null : gate.failures.map(f => f.code).join(',')),
    db.prepare('UPDATE reporting_run SET state = ?2, snapshot_id = ?3, catalog_rev = ?4, gate = ?5, catalog_info = ?6, updated_at = ?7 WHERE run_id = ?1')
      .bind(runId, finalState, id, info.rev, J(gateRecord), J(info), at),
    db.prepare(`INSERT INTO snapshot (snapshot_id, week_start, revision, status, run_id, computed_at, engine_version, catalog_rev, policy, profitability_status,
        reason, catalog_info, comparison_snapshot_id, draft_comparison, storage, manifest_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'chunked', ?15)`)
      .bind(id, u.week_start, revision, status, runId, at, head.engine_version, head.catalog_rev, head.policy, head.profitability_status,
            'collector-computed week', J(catalogInfo), head.comparison_snapshot_id, head.draft_comparison, await inputsHashOf(pinned)),
    db.prepare(`INSERT INTO snapshot_totals (snapshot_id, ${tcols.join(', ')}) VALUES (?1, ${tcols.map((_, i) => `?${i + 2}`).join(', ')})`)
      .bind(id, ...tcols.map(c => totals[c])),
    db.prepare('INSERT INTO snapshot_narrative (snapshot_id, narrative) VALUES (?1, ?2)').bind(id, index.narrative),
    db.prepare("UPDATE result_upload SET status = 'finalized', finalized_at = ?2 WHERE snapshot_id = ?1 AND status = 'open'").bind(id, at),
  ];
  try { await atomic(db, stmts); }
  catch (e) {
    if (/NOT NULL constraint failed: write_guard/i.test(String(e?.message || e))) throw new ApiError(409, 'concurrent_finalize', 'This upload was finalized or closed concurrently');
    throw e;
  }
  return json({ snapshotId: id, weekStart: u.week_start, revision, status, runState: finalState, verification: 'pending',
                gate: { passed: gate.passed, failures: gate.failures.map(f => f.code), warnings: gate.warnings.map(w => w.code) } });
}
