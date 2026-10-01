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
import { newId, nowIso, getSettings, selectIn, atomic, SETTINGS_SQL, settingsFromRows } from './db.js';
import { signManifest, manifestSignatureValid } from './auth.js';
import { readBytes, gunzipCapped, sha256Text, HEX64 } from './gz.js';
import { loadShipmentsForOrders, loadHpdForOrders, shipmentsFromRows, hpdFromRows, SHIPMENTS_SQL, SHIPMENT_ITEMS_SQL, HPD_SQL, HPD_ITEMS_SQL } from './store.js';
import { catalogFreshnessFrom, anchorFromRows, chooseCatalogFrom, refreshFromRow, previousFromRows, ANCHOR_PUBLISHED_SQL, ANCHOR_LATEST_SQL, LATEST_REFRESH_SQL, PREV_PUBLISHED_SQL, PREV_DRAFT_SQL } from './compute.js';
import { createRunStatements } from './runs.js';
import { scrBasisFrom, BASIS_VERSIONS_SQL } from './collectScr.js';
import { ENGINE_VERSION } from '../../shared/snapshot.js';
import { evaluateGate } from '../../shared/gate.js';
import { stableStringify, weekStartOf, assertNoCustomerFields, addDays, CustomerDataError, CUSTOMER_KEYS } from '../../shared/normalized.js';
import { assertReducedNormalizedOrders } from '../../shared/adapters/shopifyPrivacy.js';
import { storedOrderForm, MANIFEST_VERSION, auxHash } from '../../shared/bundle.js';
import { ORDER_COLUMNS, LINE_COLUMNS, BREAKDOWN_COLUMNS, ISSUE_COLUMNS, RECON_COLUMNS, TOTALS_COLUMNS, ORDERS_PER_PART, ORDER_INDEX_FIELDS } from '../../shared/resultParts.js';
import { weekWindowUtc } from '../../shared/schedule.js';

const P = (s, d = null) => { try { return JSON.parse(s); } catch { return d; } };
const J = v => JSON.stringify(v ?? null);
const COLLECTOR = Object.freeze({ cls: 'ingest_secret', label: 'collector' });
export const ORDERS_PER_CHUNK = 10;
// Parts hold at most 40 orders' rows (shared/resultParts.js), so these caps bound every part request's CPU.
export const PART_LIMITS = Object.freeze({ compressed: 128 * 1024, decompressed: 512 * 1024, ratio: 60 });
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

/**
 * The week's pinned inputs, exactly what the Worker's own loaders would give the engine now.
 * Reads go in three batches (one D1 round trip each) and through the same pure functions the
 * loaders use, so the request stays inside the Workers Free CPU limit.
 */
export async function assembleManifest(env, weekStart) { return (await assemble(env, weekStart)).manifest; }

/**
 * The manifest and the input epoch read at the start of its first batch. Every write to a table
 * the manifest reads increments the epoch (migration 0013 triggers), so an unchanged epoch at
 * commit time proves no input moved after these reads began.
 */
async function assemble(env, weekStart) {
  if (!WEEK_RE.test(weekStart) || weekStartOf(weekStart) !== weekStart) throw new ApiError(400, 'bad_query', 'week must be a Monday (YYYY-MM-DD)');
  const db = env.DB;
  const now = Date.now(), weekEnd = addDays(weekStart, 6), prevWeek = addDays(weekStart, -7);
  const rs = r => r.results || [], one = r => rs(r)[0] || null;
  // Batch 1: everything keyed by the week alone.
  const b1 = await db.batch([
    db.prepare('SELECT n FROM input_epoch WHERE id = 1'),
    db.prepare(SETTINGS_SQL),
    db.prepare('SELECT ship_date, version_id, day_hash FROM scr_day_owner WHERE ship_date BETWEEN ?1 AND ?2 ORDER BY ship_date').bind(weekStart, weekEnd),
    db.prepare('SELECT order_name, order_number, body_hash, source_id FROM ord_ptr WHERE week_start = ?1 ORDER BY order_name').bind(weekStart),
    db.prepare(ANCHOR_PUBLISHED_SQL).bind(weekStart),
    db.prepare(ANCHOR_LATEST_SQL).bind(weekStart),
    db.prepare(LATEST_REFRESH_SQL).bind(weekStart, new Date(now).toISOString()),
    db.prepare("SELECT * FROM cost_catalog WHERE status = 'accepted' ORDER BY COALESCE(last_pushed_at, captured_at) DESC, catalog_rev LIMIT 1"),
    db.prepare(PREV_PUBLISHED_SQL).bind(prevWeek),
    db.prepare(PREV_DRAFT_SQL).bind(prevWeek),
    db.prepare('SELECT t.shipping_expense AS e FROM snapshot s JOIN snapshot_totals t ON t.snapshot_id = s.snapshot_id WHERE s.week_start = ?1 ORDER BY s.revision DESC LIMIT 1').bind(weekStart),
    db.prepare('SELECT snapshot_id, revision, status, storage, manifest_hash FROM snapshot WHERE week_start = ?1 ORDER BY revision DESC LIMIT 1').bind(weekStart),
  ]);
  const latestSnapshot = one(b1[11]);
  const epoch = one(b1[0])?.n ?? null;
  const settings = settingsFromRows(rs(b1[1]));
  const weekOwned = rs(b1[2]), orders = rs(b1[3]);
  const anchor = anchorFromRows(one(b1[4]), one(b1[5]));
  const info = chooseCatalogFrom({ anchor, refresh: refreshFromRow(one(b1[6]), now), latest: one(b1[7]) });
  const prev = previousFromRows(one(b1[8]), one(b1[9]));
  const last = one(b1[10]);
  const closedAt = weekWindowUtc(weekStart, settings.store_timezone).endUtcExclusive;
  const nums = [...new Set(orders.map(o => o.order_number))], numsJson = JSON.stringify(nums);
  const vids = [...new Set(weekOwned.map(o => o.version_id))];
  // Batch 2: what depends on the week's orders, date owners and catalog.
  const b2 = await db.batch([
    db.prepare(BASIS_VERSIONS_SQL).bind(weekStart, weekEnd, JSON.stringify(vids)),
    db.prepare(`SELECT d.groups FROM scr_day d JOIN json_each(?1) j ON d.version_id = json_extract(j.value, '$[0]') AND d.ship_date = json_extract(j.value, '$[1]')`)
      .bind(JSON.stringify(weekOwned.map(o => [o.version_id, o.ship_date]))),
    db.prepare(SHIPMENTS_SQL).bind(numsJson), db.prepare(SHIPMENT_ITEMS_SQL).bind(numsJson),
    db.prepare(HPD_SQL).bind(numsJson), db.prepare(HPD_ITEMS_SQL).bind(numsJson),
    db.prepare('SELECT table_name, part FROM cost_catalog_part WHERE catalog_rev = ?1 ORDER BY table_name, part').bind(info.rev || ''),
    db.prepare('SELECT captured_at, meta FROM cost_catalog WHERE catalog_rev = ?1').bind(info.rev || ''),
  ]);
  const basis = scrBasisFrom({ weekStart, closedAt, own: new Map(weekOwned.map(o => [o.ship_date, { versionId: o.version_id, dayHash: o.day_hash }])), versionRows: rs(b2[0]) });
  if (basis.basisStatus !== 'ok') throw new ApiError(409, 'shipping_report_not_ready', `No snapshot: the week's Shipping Cost Report is ${basis.basisStatus} (${basis.label})`, { shippingReport: basis.basisStatus });
  // Same precedence as before the reads were batched: report basis, then catalog, then orders.
  if (!info.rev) throw new ApiError(409, 'no_catalog', 'No accepted cost catalog; push one before computing');
  if (!orders.length) throw new ApiError(409, 'week_empty', `No orders stored for the week of ${weekStart}`);
  const shipments = shipmentsFromRows(rs(b2[2]), rs(b2[3])), hpdOrders = hpdFromRows(rs(b2[4]), rs(b2[5]));
  const cat = one(b2[7]);
  info.capturedAt = cat?.captured_at || null;
  // Shipping Cost Report dates the week depends on: its own seven dates, and every owned date that
  // holds cost for one of its orders or for an order shipped in the week (that order's first ship
  // date decides the unmatched count). Other dates cannot change this week's figures, so they are
  // not pinned. The search over the stored groups runs in D1 (json_each), not in Worker CPU.
  const weekKeys = [...new Set(rs(b2[1]).flatMap(r => (P(r.groups, []) || []).map(g => g[0])))];
  const keys = [...new Set([...nums.map(n => String(n).replace(/^#/, '')), ...weekKeys])];
  // Batch 3: the related dates and the report orders that are known Shopify orders.
  const b3 = await db.batch([
    db.prepare(`SELECT DISTINCT o.ship_date, o.version_id, o.day_hash FROM scr_day_owner o
        JOIN scr_day d ON d.version_id = o.version_id AND d.ship_date = o.ship_date, json_each(d.groups) g
        WHERE json_extract(g.value, '$[0]') IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(keys)),
    db.prepare('SELECT DISTINCT order_number FROM ord_ptr WHERE order_number IN (SELECT value FROM json_each(?1)) ORDER BY order_number').bind(JSON.stringify(weekKeys)),
    db.prepare(`SELECT v.version_id, v.source_id, v.requested_from, v.requested_to FROM scr_version v WHERE v.version_id IN (
        SELECT DISTINCT o.version_id FROM scr_day_owner o JOIN scr_day d ON d.version_id = o.version_id AND d.ship_date = o.ship_date, json_each(d.groups) g
        WHERE json_extract(g.value, '$[0]') IN (SELECT value FROM json_each(?1))) OR v.version_id IN (SELECT value FROM json_each(?2)) ORDER BY v.version_id`)
      .bind(JSON.stringify(keys), JSON.stringify(vids)),
  ]);
  const owners = [...new Map([...weekOwned, ...rs(b3[0])].map(o => [o.ship_date, o])).values()].sort((a, b) => (a.ship_date < b.ship_date ? -1 : 1));
  const known = weekKeys.length ? rs(b3[1]).map(r => r.order_number) : [];
  const versions = rs(b3[2]);
  return { epoch, latestSnapshot, manifest: {
    v: MANIFEST_VERSION, weekStart, engineVersion: ENGINE_VERSION, asOf: new Date(now).toISOString(), storeTimezone: settings.store_timezone, settings,
    catalog: { rev: info.rev, info, completeness: P(cat?.meta, {})?.completeness || null, parts: rs(b2[6]).map(p => [p.table_name, p.part]) },
    orders: orders.map(o => [o.order_name, o.body_hash, o.source_id]),
    scrDays: owners.map(o => [o.ship_date, o.version_id, o.day_hash]),
    scrVersions: versions.map(v => [v.version_id, v.source_id, v.requested_from, v.requested_to]),
    knownReportKeys: known,
    aux: { shipmentsHash: await auxHash(shipments), hpdHash: await auxHash(hpdOrders), shipments: shipments.length, hpdOrders: hpdOrders.length },
    previous: prev.published, previousDraft: prev.draft, previousShippingExpense: last ? last.e : null,
    shippingReportBasis: basis, publicationAllowedEnv: env.PUBLICATION_ALLOWED === 'true',
  } };
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
  const { manifest, epoch, latestSnapshot: latest } = await assemble(env, weekStart);
  const manifestHash = await sha256Text(stableStringify(manifest));
  // The week's newest revision was computed from exactly these inputs: nothing to do (a retry or re-run writes 0 rows).
  const existing = latest?.storage === 'chunked' && latest.manifest_hash === await inputsHashOf(manifest)
    ? { snapshotId: latest.snapshot_id, revision: latest.revision, status: latest.status } : null;
  return json({ manifest, manifestHash, epoch, signature: await signManifest(env, manifestHash, epoch), existing });
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

export const PART_NAME = /^(orderindex|sections|orders:\d{1,4}|lines:\d{1,4}|scenario:\d{1,4})$/;
const keysOf = cols => new Set(cols.map(c => c[0]));
const ORDER_KEYS = keysOf(ORDER_COLUMNS), LINE_KEYS = keysOf(LINE_COLUMNS), BD_KEYS = keysOf(BREAKDOWN_COLUMNS),
      ISSUE_KEYS = keysOf(ISSUE_COLUMNS), RECON_KEYS = keysOf(RECON_COLUMNS);
const SCENARIO_KEYS = new Set(['orderNum', 'date', 'sku', 'product', 'vendor', 'vendorKey', 'qty', 'unitPrice', 'baseMerchRevenue', 'lineRevenue',
  'lineCogs', 'missingCost', 'costSource', 'isRoute', 'isGiftCard', 'isInfluencerSample', 'shipCollected', 'shipPaid']);
// No allowlisted result column may be a customer field (the part check relies on it).
for (const k of [...ORDER_KEYS, ...LINE_KEYS, ...BD_KEYS, ...ISSUE_KEYS, ...RECON_KEYS, ...SCENARIO_KEYS]) {
  if (CUSTOMER_KEYS.has(k.toLowerCase().replace(/[^a-z0-9]/g, ''))) throw new Error(`result column ${k} is a customer field`);
}
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
  const only = keys => { if (Object.keys(v).length !== keys.length || keys.some(k => !(k in v))) throw new ApiError(400, 'part_invalid', `Part must have exactly ${keys.join(', ')}`); };
  if (name === 'orderindex') {
    only(['orders']);
    if (!Array.isArray(v.orders) || v.orders.some(t => !Array.isArray(t) || t.length !== ORDER_INDEX_FIELDS.length || typeof t[0] !== 'string' || !Number.isInteger(t[1]) || t[1] < 0
        || t.slice(2).some(x => x !== null && typeof x !== 'string' && typeof x !== 'number'))) throw new ApiError(400, 'part_invalid', 'orderindex.orders must be order tuples');
  } else if (name.startsWith('orders:')) {
    only(['orders']);
    rowsExactly(v.orders, ORDER_KEYS, 'orders');
    if (v.orders.length > ORDERS_PER_PART) throw new ApiError(400, 'part_invalid', `At most ${ORDERS_PER_PART} orders per part`);
  } else if (name === 'sections') {
    rowsExactly(v.breakdowns, BD_KEYS, 'breakdowns'); rowsExactly(v.reconciliation, RECON_KEYS, 'reconciliation'); rowsExactly(v.issues, ISSUE_KEYS, 'issues');
  } else if (name.startsWith('scenario:')) {
    only(['lines']);
    rowsExactly(v.lines, SCENARIO_KEYS, 'scenario.lines');
  } else { only(['lines']); rowsExactly(v.lines, LINE_KEYS, 'lines'); }
  // Row parts carry only allowlisted columns (checked above; none is a customer field, asserted at load),
  // so only the one free-form object needs the customer-field walk.
  if (name === 'sections') { try { assertNoCustomerFields(v.shippingC3 ?? null); } catch { throw new ApiError(400, 'customer_data_rejected', 'A result part contains customer fields'); } }
}

export async function openResults(request, env, weekStart) {
  const b = await readJson(request);
  const { manifest, manifestHash, signature, index, epoch } = b;
  if (!manifest || manifest.weekStart !== weekStart) throw new ApiError(400, 'bad_payload', 'manifest for this week is required');
  if (await sha256Text(stableStringify(manifest)) !== manifestHash) throw new ApiError(400, 'hash_mismatch', 'manifestHash does not match the manifest');
  if (!(await manifestSignatureValid(env, manifestHash, signature, epoch))) throw new ApiError(403, 'manifest_not_issued', 'This manifest was not issued by this Worker');
  if (Date.now() - Date.parse(manifest.asOf) > MANIFEST_MAX_AGE_MS) throw new ApiError(409, 'manifest_expired', 'The manifest is older than 6 hours; fetch a new one');
  if (manifest.engineVersion !== ENGINE_VERSION || index?.engineVersion !== ENGINE_VERSION) throw new ApiError(409, 'engine_version_mismatch', `This Worker accepts results of engine ${ENGINE_VERSION} only`);
  const names = Object.keys(index?.parts || {});
  if (!names.includes('orderindex') || !names.includes('sections') || names.some(n => !PART_NAME.test(n) || !HEX64.test(index.parts[n]))) throw new ApiError(400, 'bad_payload', 'index.parts must name orderindex, sections, orders:k, lines:k and scenario:j with sha256 values');
  const numbered = prefix => names.filter(n => n.startsWith(prefix)).map(n => Number(n.slice(prefix.length))).sort((a, c) => a - c);
  const [op, lp, sp] = [numbered('orders:'), numbered('lines:'), numbered('scenario:')];
  if ([op, lp, sp].some(xs => xs.some((k, i) => k !== i)) || !op.length || !sp.length || !(lp.length === op.length || lp.length === op.length + 1)) throw new ApiError(400, 'bad_payload', 'orders:k, lines:k and scenario:j must be numbered 0…n−1 (lines: one per orders part, plus at most one)');
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
  // An upload of these exact results is already open (a retry): reuse it and report what is still missing.
  const same = (await db.prepare(`SELECT u.snapshot_id, (SELECT json_group_array(part) FROM snapshot_blob b WHERE b.snapshot_id = u.snapshot_id) AS have FROM result_upload u
      WHERE u.week_start = ?1 AND u.manifest_hash = ?2 AND u.status = 'open' AND u.idx = ?3`).bind(weekStart, manifestHash, idx).first());
  if (same) { const have = new Set(P(same.have, [])); return json({ snapshotId: same.snapshot_id, missing: names.filter(n => !have.has(n)) }); }
  const snapshotId = newId('snp');
  await db.prepare('INSERT INTO result_upload (snapshot_id, week_start, manifest_hash, engine_version, idx, manifest, status, created_at, manifest_epoch) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)')
    .bind(snapshotId, weekStart, manifestHash, ENGINE_VERSION, idx, J(manifest), 'open', nowIso(), epoch).run();
  return json({ snapshotId, missing: names });
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
  // The stored text must be exactly the serialization of what was validated (no duplicate keys,
  // whitespace or alternative escapes): reads may serve it as text. Key order is the collector's
  // canonical order; the verifier compares every part byte for byte with its own recomputation.
  if (JSON.stringify(v) !== text) throw new ApiError(400, 'not_canonical', 'Part is not canonical JSON');
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
  // One round for every read finalize needs besides the manifest re-assembly.
  const [epochRow, partRows, hpdRun, otherTz, maxRev] = await db.batch([
    db.prepare('SELECT n FROM input_epoch WHERE id = 1'),
    db.prepare('SELECT part FROM snapshot_blob WHERE snapshot_id = ?1').bind(id),
    db.prepare("SELECT status FROM ingest_run WHERE source = 'hpd' AND week_start = ?1 ORDER BY started_at DESC LIMIT 1").bind(u.week_start),
    db.prepare('SELECT COUNT(*) AS n FROM ord_ptr WHERE week_start = ?1 AND timezone <> ?2').bind(u.week_start, pinned.settings?.store_timezone ?? ''),
    db.prepare('SELECT MAX(revision) AS m FROM snapshot WHERE week_start = ?1').bind(u.week_start),
  ]);
  const have = new Set((partRows.results || []).map(r => r.part));
  const missing = names.filter(n => !have.has(n));
  if (missing.length) throw new ApiError(409, 'parts_missing', `${missing.length} part(s) not uploaded yet`, { missing });
  // Inputs must be exactly what the manifest pinned: otherwise the result is for a stale week.
  // Fast path: no input was written since the manifest was assembled (same epoch), it is recent,
  // and nothing in it depends on the clock (a catalog refresh still pending can expire) → the
  // pinned manifest is still exact. Otherwise rebuild it and compare.
  let epoch = epochRow.results?.[0]?.n ?? null;
  const fresh = epoch !== null && u.manifest_epoch === epoch && Date.now() - Date.parse(pinned.asOf) <= MANIFEST_MAX_AGE_MS
    && pinned.catalog?.info?.refreshStatus !== 'pending' && pinned.publicationAllowedEnv === (env.PUBLICATION_ALLOWED === 'true');
  let current = pinned;
  if (!fresh) {
    try { ({ manifest: current, epoch } = await assemble(env, u.week_start)); }
    catch (e) { if (e instanceof ApiError) { await db.prepare("UPDATE result_upload SET status = 'abandoned' WHERE snapshot_id = ?1").bind(id).run(); } throw e; }
  }
  if (!fresh && stableStringify(withoutAsOf(current)) !== stableStringify(withoutAsOf(pinned))) {
    await db.prepare("UPDATE result_upload SET status = 'abandoned' WHERE snapshot_id = ?1 AND status = 'open'").bind(id).run();
    throw new ApiError(409, 'inputs_changed', "The week's inputs changed after the manifest was issued; fetch a new manifest and recompute");
  }
  const settings = pinned.settings, info = pinned.catalog.info, basis = pinned.shippingReportBasis;
  const runId = newId('run'), at = nowIso();
  // A fresh run id never has a catalog reuse acceptance, so freshness is the pure function of the selection.
  const freshness = catalogFreshnessFrom(info);
  const catalogInfo = { ...info, freshness };
  const h = hpdRun.results?.[0];
  const hpdStatus = h ? (h.status === 'ok' ? 'ok' : h.status === 'failed' ? 'failed' : 'pending') : (pinned.aux.hpdOrders > 0 ? 'ok' : 'pending');
  const sources = { shopify: 'ok', shipstation: 'ok', hpd: hpdStatus };
  const ordersInOtherTimezone = otherTz.results?.[0]?.n || 0;
  const gi = index.gateInputs;
  const gate = evaluateGate({ totals: gi.totals, reconciliation: gi.reconciliation, sources, catalog: { accepted: true, rev: info.rev, freshness },
                              settings, ordersInOtherTimezone, shippingC3: gi.shippingC3, shippingReport: basis });
  const gateRecord = { ...gate, sources, shippingReport: basis, storeTimezone: settings.store_timezone, storeTimezoneConfirmed: settings.store_timezone_confirmed === true,
    catalog: { expectedRefreshId: info.refreshId || null, selectedRev: info.rev, capturedAt: info.capturedAt, basis: info.basis, freshness },
    computedBy: 'collector', verification: 'pending' };
  const revision = (maxRev.results?.[0]?.m || 0) + 1;
  const status = gate.passed ? 'draft' : 'blocked', finalState = gate.passed ? 'validated' : 'blocked';
  const head = index.head, totals = P(index.totals);
  const tcols = TOTALS_COLUMNS.map(c => c[0]);
  const stmts = [
    // No input changed since the re-assembled manifest was read (checked inside this transaction).
    db.prepare('INSERT INTO input_epoch_guard (ok) SELECT NULL WHERE NOT ((SELECT n FROM input_epoch WHERE id = 1) IS ?1)').bind(epoch),
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
    // The upload stays open: a retry re-checks the inputs and either commits (nothing this week reads
    // changed) or answers inputs_changed and abandons the upload.
    if (/NOT NULL constraint failed: input_epoch_guard/i.test(String(e?.message || e))) throw new ApiError(409, 'inputs_moved', 'An input was written while this week was being finalized; retry finalize');
    if (/NOT NULL constraint failed: write_guard/i.test(String(e?.message || e))) throw new ApiError(409, 'concurrent_finalize', 'This upload was finalized or closed concurrently');
    throw e;
  }
  return json({ snapshotId: id, weekStart: u.week_start, revision, status, runState: finalState, verification: 'pending',
                gate: { passed: gate.passed, failures: gate.failures.map(f => f.code), warnings: gate.warnings.map(w => w.code) } });
}
