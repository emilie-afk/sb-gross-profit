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
import { ApiError, json, jsonText, readJson, WEEK_RE } from './http.js';
import { newId, nowIso, getSettings, selectIn, atomic, SETTINGS_SQL, settingsFromRows, LATEST_ACCEPTED_WHERE } from './db.js';
import { signManifest, manifestSignatureValid } from './auth.js';
import { readBytes, gunzipCapped, sha256Text, HEX64 } from './gz.js';
import { loadShipmentsForOrders, loadHpdForOrders, shipmentsFromRows, hpdFromRows, SHIPMENTS_SQL, SHIPMENT_ITEMS_SQL, HPD_SQL, HPD_ITEMS_SQL } from './store.js';
import { catalogFreshnessFrom, anchorFromRows, chooseCatalogFrom, refreshFromRow, previousFromRows, ANCHOR_PUBLISHED_SQL, ANCHOR_LATEST_SQL, LATEST_REFRESH_SQL, PREV_PUBLISHED_SQL, PREV_DRAFT_SQL, PINNED_ACCEPTANCE_SQL } from './compute.js';
import { actorFor } from './actor.js';
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
const RAW_ORDERS = Object.freeze({ rawOrders: true });   // placeholder: getManifest splices D1's order-list text in
async function assemble(env, weekStart, { rawOrders = false } = {}) {
  if (!WEEK_RE.test(weekStart) || weekStartOf(weekStart) !== weekStart) throw new ApiError(400, 'bad_query', 'week must be a Monday (YYYY-MM-DD)');
  const db = env.DB;
  const now = Date.now(), weekEnd = addDays(weekStart, 6), prevWeek = addDays(weekStart, -7);
  const rs = r => r.results || [], one = r => rs(r)[0] || null;
  // Batch 1: everything keyed by the week alone.
  const b1 = await db.batch([
    db.prepare('SELECT n, aux_n, m FROM input_epoch WHERE id = 1'),
    db.prepare(SETTINGS_SQL),
    db.prepare('SELECT ship_date, version_id, day_hash FROM scr_day_owner WHERE ship_date BETWEEN ?1 AND ?2 ORDER BY ship_date').bind(weekStart, weekEnd),
    // The week's order list rendered by D1 as the manifest's JSON (no per-row objects in the Worker).
    db.prepare(`SELECT COUNT(*) AS n, json_group_array(json_array(order_name, body_hash, source_id) ORDER BY order_name) AS j,
        (SELECT json_group_array(DISTINCT order_number) FROM ord_ptr WHERE week_start = ?1) AS nums FROM ord_ptr WHERE week_start = ?1`).bind(weekStart),
    db.prepare(ANCHOR_PUBLISHED_SQL).bind(weekStart),
    db.prepare(ANCHOR_LATEST_SQL).bind(weekStart),
    db.prepare(LATEST_REFRESH_SQL).bind(weekStart, new Date(now).toISOString()),
    db.prepare(`SELECT * FROM cost_catalog WHERE ${LATEST_ACCEPTED_WHERE} ORDER BY COALESCE(last_pushed_at, captured_at) DESC, catalog_rev LIMIT 1`),
    db.prepare(PREV_PUBLISHED_SQL).bind(prevWeek),
    db.prepare(PREV_DRAFT_SQL).bind(prevWeek),
    db.prepare('SELECT t.shipping_expense AS e FROM snapshot s JOIN snapshot_totals t ON t.snapshot_id = s.snapshot_id WHERE s.week_start = ?1 ORDER BY s.revision DESC LIMIT 1').bind(weekStart),
    db.prepare('SELECT snapshot_id, revision, status, storage, manifest_hash FROM snapshot WHERE week_start = ?1 ORDER BY revision DESC LIMIT 1').bind(weekStart),
    db.prepare('SELECT aux_n, shipments_hash, hpd_hash, shipments, hpd_orders FROM aux_pin WHERE week_start = ?1').bind(weekStart),
    db.prepare(PINNED_ACCEPTANCE_SQL).bind(weekStart),
    db.prepare(CORRECTION_FOR_WEEK_SQL).bind(weekStart),
  ]);
  const latestSnapshot = one(b1[11]);
  // The week's aux hashes pinned by POST …/aux-pin while no aux table has changed since (same
  // transaction as the epoch read): the shipments are then neither loaded nor hashed here.
  const pin = one(b1[12]), auxN = one(b1[0])?.aux_n ?? null;
  const pinned = pin && auxN !== null && pin.aux_n === auxN
    ? { shipmentsHash: pin.shipments_hash, hpdHash: pin.hpd_hash, shipments: pin.shipments, hpdOrders: pin.hpd_orders } : null;
  const epoch = one(b1[0])?.n ?? null;
  const settings = settingsFromRows(rs(b1[1]));
  const weekOwned = rs(b1[2]), ow = one(b1[3]) || { n: 0, j: '[]', nums: '[]' };
  // Plain ASCII without escapes (order names, hex hashes, ids): D1's JSON text is byte-identical to
  // JSON.stringify and to the key-sorted form; anything else is parsed and rendered by the Worker.
  const ordersText = /^[\x20-\x5b\x5d-\x7e]*$/.test(ow.j) ? ow.j : null;
  const ordersList = () => JSON.parse(ow.j);
  const anchor = anchorFromRows(one(b1[4]), one(b1[5]));
  let info = chooseCatalogFrom({ anchor, refresh: refreshFromRow(one(b1[6]), now), latest: one(b1[7]) });
  // An audited cost correction naming this week (migration 0022): applied while the week is still on the
  // correction's original catalog; the correction id travels with the corrected catalog after that.
  info = correctedCatalog(info, { anchor, correction: one(b1[14]) });
  // The week's audited acceptance of its pinned catalog counts only for exactly that revision.
  // In the inputs (catalogAcceptance) whatever the anchor, so publishing the week does not change its inputs.
  const pinAcc = one(b1[13]);
  const catalogAcceptance = pinAcc && pinAcc.catalog_rev === info.rev ? { rev: info.rev, at: pinAcc.at } : null;
  if (catalogAcceptance && info.basis === 'previous_snapshot') {
    info.pinnedAcceptance = { catalogRev: pinAcc.catalog_rev, reason: pinAcc.reason, actorClass: pinAcc.actor_class, actorLabel: pinAcc.actor_label, at: pinAcc.at };
  }
  // Reporting starts on REPORTING_START_DATE (owner decision: the 2026 view starts Jan 1, 2026). A week
  // that ends before it is not reported; the week containing it is a partial week (orders from that date).
  const reportingStart = reportingStartOf(env);
  if (reportingStart && addDays(weekStart, 6) < reportingStart) {
    throw new ApiError(409, 'before_reporting_start', `The week of ${weekStart} ends before reporting starts (${reportingStart})`);
  }
  const prev = previousFromRows(one(b1[8]), one(b1[9]));
  const last = one(b1[10]);
  const closedAt = weekWindowUtc(weekStart, settings.store_timezone).endUtcExclusive;
  const nums = JSON.parse(ow.nums || '[]'), numsJson = JSON.stringify(nums);
  const vids = [...new Set(weekOwned.map(o => o.version_id))];
  // Batch 2: what depends on the week's orders, date owners and catalog.
  const b2 = await db.batch([
    db.prepare(BASIS_VERSIONS_SQL).bind(weekStart, weekEnd, JSON.stringify(vids)),
    db.prepare(`SELECT DISTINCT json_extract(g.value, '$[0]') AS k FROM scr_day d JOIN json_each(?1) j ON d.version_id = json_extract(j.value, '$[0]') AND d.ship_date = json_extract(j.value, '$[1]'),
        json_each(d.groups) g`).bind(JSON.stringify(weekOwned.map(o => [o.version_id, o.ship_date]))),
    db.prepare('SELECT table_name, part FROM cost_catalog_part WHERE catalog_rev = ?1 ORDER BY table_name, part').bind(info.rev || ''),
    db.prepare('SELECT captured_at, meta FROM cost_catalog WHERE catalog_rev = ?1').bind(info.rev || ''),
    ...(pinned ? [] : [db.prepare(SHIPMENTS_SQL).bind(numsJson), db.prepare(SHIPMENT_ITEMS_SQL).bind(numsJson),
                       db.prepare(HPD_SQL).bind(numsJson), db.prepare(HPD_ITEMS_SQL).bind(numsJson)]),
  ]);
  const basis = scrBasisFrom({ weekStart, closedAt, own: new Map(weekOwned.map(o => [o.ship_date, { versionId: o.version_id, dayHash: o.day_hash }])), versionRows: rs(b2[0]) });
  if (basis.basisStatus !== 'ok') throw new ApiError(409, 'shipping_report_not_ready', `No snapshot: the week's Shipping Cost Report is ${basis.basisStatus} (${basis.label})`, { shippingReport: basis.basisStatus });
  // Same precedence as before the reads were batched: report basis, then catalog, then orders.
  if (!info.rev) throw new ApiError(409, 'no_catalog', 'No accepted cost catalog; push one before computing');
  if (!ow.n) throw new ApiError(409, 'week_empty', `No orders stored for the week of ${weekStart}`);
  const aux = pinned || await auxOf(shipmentsFromRows(rs(b2[4]), rs(b2[5])), hpdFromRows(rs(b2[6]), rs(b2[7])));
  const cat = one(b2[3]);
  info.capturedAt = cat?.captured_at || null;
  // Shipping Cost Report dates the week depends on: its own seven dates, and every owned date that
  // holds cost for one of its orders or for an order shipped in the week (that order's first ship
  // date decides the unmatched count). Other dates cannot change this week's figures, so they are
  // not pinned. The search is an indexed lookup of the keys (scr_day_key, migration 0020).
  const weekKeys = rs(b2[1]).map(r => r.k);                                          // distinct, extracted in D1
  const keys = [...new Set([...nums.map(n => String(n).replace(/^#/, '')), ...weekKeys])];
  // Batch 3: the related dates and the report orders that are known Shopify orders.
  const b3 = await db.batch([
    db.prepare(RELATED_DATES_SQL).bind(JSON.stringify(keys)),
    db.prepare(KNOWN_KEYS_SQL).bind(JSON.stringify(weekKeys)),
    db.prepare(RELATED_VERSIONS_SQL).bind(JSON.stringify(keys), JSON.stringify(vids)),
  ]);
  const owners = [...new Map([...weekOwned, ...rs(b3[0])].map(o => [o.ship_date, o])).values()].sort((a, b) => (a.ship_date < b.ship_date ? -1 : 1));
  const known = weekKeys.length ? rs(b3[1]).map(r => r.order_number) : [];
  const versions = rs(b3[2]);
  // Dates whose owner kept accepted costs a later report omitted: the manifest names each kept cost's
  // source version, so the verifier can trace it, and lists those versions among scrVersions.
  const preservedOf = new Map(versions.map(v => [v.version_id, P(v.preserved, null) || {}]));
  const keptFrom = [...new Set(owners.flatMap(o => (preservedOf.get(o.version_id)?.[o.ship_date] || []).map(x => x[1])))]
    .filter(v => !preservedOf.has(v));
  if (keptFrom.length) versions.push(...rs(await db.prepare('SELECT version_id, source_id, requested_from, requested_to FROM scr_version WHERE version_id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(keptFrom)).all()));
  versions.sort((a, b) => (a.version_id < b.version_id ? -1 : a.version_id > b.version_id ? 1 : 0));
  const mEpoch = one(b1[0])?.m ?? null;
  const anchorIds = { published: one(b1[4])?.snapshot_id ?? null, prevPublished: one(b1[8])?.snapshot_id ?? null };
  return { epoch, mEpoch, anchorIds, latestSnapshot, ordersText, manifest: {
    v: MANIFEST_VERSION, weekStart, engineVersion: ENGINE_VERSION, asOf: new Date(now).toISOString(), storeTimezone: settings.store_timezone, settings,
    catalog: { rev: info.rev, info, completeness: P(cat?.meta, {})?.completeness || null, parts: rs(b2[2]).map(p => [p.table_name, p.part]) },
    orders: rawOrders && ordersText ? RAW_ORDERS : ordersList(),
    scrDays: owners.map(o => { const kept = preservedOf.get(o.version_id)?.[o.ship_date]; return kept?.length ? [o.ship_date, o.version_id, o.day_hash, kept] : [o.ship_date, o.version_id, o.day_hash]; }),
    scrVersions: versions.map(v => [v.version_id, v.source_id, v.requested_from, v.requested_to]),
    knownReportKeys: known,
    aux,
    previous: prev.published, previousDraft: prev.draft, previousShippingExpense: last ? last.e : null,
    shippingReportBasis: basis, publicationAllowedEnv: env.PUBLICATION_ALLOWED === 'true',
    ...(reportingStart && weekStart < reportingStart ? { reportingStart } : {}),
    ...(catalogAcceptance ? { catalogAcceptance } : {}),
  } };
}
/**
 * Owned dates (and their versions) whose stored groups hold one of the order keys ?1: an indexed
 * lookup in scr_day_key joined to the current owners. Before migration 0020 this searched every
 * stored day's JSON groups (≈15k rows read per call with a year of history).
 */
export const RELATED_DATES_SQL = `SELECT DISTINCT o.ship_date, o.version_id, o.day_hash FROM scr_day_key k
    JOIN scr_day_owner o ON o.ship_date = k.ship_date AND o.version_id = k.version_id
    WHERE k.order_key IN (SELECT value FROM json_each(?1))`;
/** The report order keys ?1 that are stored Shopify orders (idx_ord_ptr_number, migration 0020). */
export const KNOWN_KEYS_SQL = 'SELECT DISTINCT order_number FROM ord_ptr WHERE order_number IN (SELECT value FROM json_each(?1)) ORDER BY order_number';
/** The versions owning those dates, plus the week's own versions ?2. */
export const RELATED_VERSIONS_SQL = `SELECT v.version_id, v.source_id, v.requested_from, v.requested_to, json_extract(v.outcome, '$.preserved') AS preserved FROM scr_version v
    WHERE v.version_id IN (SELECT o.version_id FROM scr_day_key k JOIN scr_day_owner o ON o.ship_date = k.ship_date AND o.version_id = k.version_id
                           WHERE k.order_key IN (SELECT value FROM json_each(?1)))
       OR v.version_id IN (SELECT value FROM json_each(?2)) ORDER BY v.version_id`;
const withoutAsOf = ({ asOf: _a, ...m }) => m;
/** REPORTING_START_DATE (Worker variable, YYYY-MM-DD) or null when reporting has no start date. */
export const reportingStartOf = env => (/^\d{4}-\d{2}-\d{2}$/.test(env?.REPORTING_START_DATE || '') ? env.REPORTING_START_DATE : null);
const auxOf = async (shipments, hpdOrders) => ({ shipmentsHash: await auxHash(shipments), hpdHash: await auxHash(hpdOrders), shipments: shipments.length, hpdOrders: hpdOrders.length });

/**
 * POST /v1/collect/weeks/:week/aux-pin (ingest). Computes the week's aux hashes (what GET …/aux
 * serves, hashed as the manifest pins them) in this request, so the manifest request does not.
 * A pin stays valid while input_epoch.aux_n is unchanged; an unchanged pin writes nothing.
 */
export async function pinAux(env, weekStart) {
  if (!WEEK_RE.test(weekStart) || weekStartOf(weekStart) !== weekStart) throw new ApiError(400, 'bad_query', 'week must be a Monday (YYYY-MM-DD)');
  const db = env.DB;
  const [er, pr] = await db.batch([db.prepare('SELECT aux_n FROM input_epoch WHERE id = 1'), db.prepare('SELECT aux_n, shipments, hpd_orders FROM aux_pin WHERE week_start = ?1').bind(weekStart)]);
  const now = er.results?.[0]?.aux_n, have = pr.results?.[0];
  if (have && have.aux_n === now) return json({ weekStart, auxN: now, shipments: have.shipments, hpdOrders: have.hpd_orders, pinned: 'unchanged' });
  // The rows and the counter in one transaction: the hashes belong to exactly that aux_n.
  const WEEK = 'SELECT order_number FROM ord_ptr WHERE week_start = ?1', inWeek = sql => sql.split('SELECT value FROM json_each(?1)').join(WEEK);
  const [e2, s1, s2, h1, h2] = await db.batch([db.prepare('SELECT aux_n FROM input_epoch WHERE id = 1'),
    ...[SHIPMENTS_SQL, SHIPMENT_ITEMS_SQL, HPD_SQL, HPD_ITEMS_SQL].map(q => db.prepare(inWeek(q)).bind(weekStart))]);
  const n = e2.results?.[0]?.aux_n;
  const a = await auxOf(shipmentsFromRows(s1.results || [], s2.results || []), hpdFromRows(h1.results || [], h2.results || []));
  await db.prepare(`INSERT INTO aux_pin (week_start, aux_n, shipments_hash, hpd_hash, shipments, hpd_orders, pinned_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT(week_start) DO UPDATE SET aux_n = excluded.aux_n, shipments_hash = excluded.shipments_hash, hpd_hash = excluded.hpd_hash,
        shipments = excluded.shipments, hpd_orders = excluded.hpd_orders, pinned_at = excluded.pinned_at WHERE aux_pin.aux_n < excluded.aux_n`)
    .bind(weekStart, n, a.shipmentsHash, a.hpdHash, a.shipments, a.hpdOrders, nowIso()).run();
  return json({ weekStart, auxN: n, shipments: a.shipments, hpdOrders: a.hpdOrders, pinned: 'pinned' });
}

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
const INPUT_EXCLUDED = new Set(['asOf', 'previousShippingExpense', 'previousDraft']);
/**
 * Both hashes from one key-sorted rendering of each top-level field (the order list dominates the
 * manifest; it is rendered once instead of twice). Equal to sha256(stableStringify(m)) and inputsHashOf(m).
 */
async function manifestHashes(m, ordersText = null) {
  const keys = Object.keys(m).sort();
  const piece = new Map(keys.map(k => [k, k === 'orders' && m[k] === RAW_ORDERS ? ordersText : stableStringify(m[k])]));
  const { info: _i, ...catalog } = m.catalog;
  const join = (ks, f) => `{${ks.map(k => `${JSON.stringify(k)}:${f(k)}`).join(',')}}`;
  return [await sha256Text(join(keys, k => piece.get(k))),
          await sha256Text(join(keys.filter(k => !INPUT_EXCLUDED.has(k)), k => (k === 'catalog' ? stableStringify(catalog) : piece.get(k))))];
}

/**
 * The newest audited correction naming week ?1 (migration 0022): its id, the week's original catalog
 * revision and the corrected one. Weeks not named have none.
 */
export const CORRECTION_FOR_WEEK_SQL = `SELECT w.correction_id, w.from_catalog_rev, w.to_catalog_rev FROM cost_correction_week w
    JOIN cost_correction c ON c.correction_id = w.correction_id WHERE w.week_start = ?1 ORDER BY c.at DESC, c.correction_id DESC LIMIT 1`;
/**
 * Pure: the catalog choice with a week's correction applied.
 *   - The week is still on the correction's original catalog → the corrected catalog, basis
 *     cost_restatement (freshness 'restated'), naming the correction and what it replaces.
 *   - The week is already on the corrected catalog → the usual choice, carrying the correction id, so
 *     every later revision on that catalog records which correction it applies.
 *   - Anything else (no correction, no snapshot, another catalog) → the usual choice, unchanged.
 */
export function correctedCatalog(info, { anchor, correction }) {
  if (!correction || !anchor) return info;
  if (anchor.rev === correction.from_catalog_rev) {
    return { rev: correction.to_catalog_rev, basis: 'cost_restatement', correctionId: correction.correction_id,
             fromCatalogRev: anchor.rev, fromSnapshotId: anchor.fromSnapshotId, refreshId: null };
  }
  if (anchor.rev === correction.to_catalog_rev && info.rev === correction.to_catalog_rev) return { ...info, correctionId: correction.correction_id };
  return info;
}

/**
 * GET /v1/collect/corrections/pending?after=&limit= (ingest): named weeks whose correction still applies
 * (the week's catalog — its published revision's, else its newest revision's — is the correction's
 * original) and whose newest revision is not yet on the corrected catalog with this correction's id.
 * Completion is by correction id and catalog revision, never by time. Oldest first, paged (≤ 50).
 */
export const CORRECTIONS_PENDING_SQL = `WITH cw AS (
      SELECT w.week_start, w.correction_id, w.from_catalog_rev, w.to_catalog_rev,
             ROW_NUMBER() OVER (PARTITION BY w.week_start ORDER BY c.at DESC, c.correction_id DESC) AS k
        FROM cost_correction_week w JOIN cost_correction c ON c.correction_id = w.correction_id WHERE w.week_start > ?1)
    SELECT cw.week_start, cw.correction_id FROM cw
    JOIN snapshot s ON s.week_start = cw.week_start AND s.storage = 'chunked'
      AND NOT EXISTS (SELECT 1 FROM snapshot n WHERE n.week_start = s.week_start AND n.revision > s.revision)
    WHERE cw.k = 1
      AND COALESCE((SELECT p.catalog_rev FROM snapshot p WHERE p.week_start = cw.week_start AND p.status = 'published'), s.catalog_rev) = cw.from_catalog_rev
      AND NOT (s.catalog_rev = cw.to_catalog_rev AND json_extract(s.catalog_info, '$.correctionId') IS cw.correction_id)
    ORDER BY cw.week_start LIMIT ?2`;
export async function correctionsPending(env, request) {
  const q = new URL(request.url).searchParams;
  const after = q.get('after') || '0000-00-00';
  if (after !== '0000-00-00' && !WEEK_RE.test(after)) throw new ApiError(400, 'bad_query', 'after must be YYYY-MM-DD');
  const limit = Math.min(50, Math.max(1, Number(q.get('limit')) || 50));
  const rows = (await env.DB.prepare(CORRECTIONS_PENDING_SQL).bind(after, limit + 1).all()).results || [];
  const page = rows.slice(0, limit);
  return json({ weeks: page.map(r => ({ weekStart: r.week_start, correctionId: r.correction_id })), next: rows.length > limit ? page[page.length - 1].week_start : null });
}

/**
 * Leaf-by-leaf differences between two stored catalogs, every table except ?3 (the MCG pack table),
 * computed by D1 from the stored parts (formatting and chunking do not matter). 0 = identical.
 */
export const CATALOG_DIFF_EXCEPT_SQL = `WITH
    a AS (SELECT table_name, group_concat(payload, '' ORDER BY part) AS j FROM cost_catalog_part WHERE catalog_rev = ?1 AND table_name <> ?3 GROUP BY table_name),
    b AS (SELECT table_name, group_concat(payload, '' ORDER BY part) AS j FROM cost_catalog_part WHERE catalog_rev = ?2 AND table_name <> ?3 GROUP BY table_name),
    la AS (SELECT a.table_name AS t, x.fullkey AS k, x.atom AS v FROM a, json_tree(a.j) x WHERE x.type NOT IN ('object', 'array')),
    lb AS (SELECT b.table_name AS t, x.fullkey AS k, x.atom AS v FROM b, json_tree(b.j) x WHERE x.type NOT IN ('object', 'array'))
  SELECT (SELECT COUNT(*) FROM (SELECT t, k, v FROM la EXCEPT SELECT t, k, v FROM lb))
       + (SELECT COUNT(*) FROM (SELECT t, k, v FROM lb EXCEPT SELECT t, k, v FROM la)) AS n`;
export const MCG_TABLE = 'mcg_pack';

/**
 * POST /v1/admin/cost-corrections { reason, weeks: [{ weekStart, fromCatalogRev, toCatalogRev }] }
 * GET  /v1/admin/cost-corrections — every correction with its weeks (who, why, which catalogs).
 * The audited correction path. Each named week must have a snapshot whose catalog (the published
 * revision's, else the newest's) is exactly fromCatalogRev; toCatalogRev must be an accepted catalog
 * identical to fromCatalogRev except the MCG pack table, which it must hold and change. Nothing is
 * recomputed or overwritten here: the collector's next run computes the corrected revisions, the
 * verifier checks them and publication follows the usual controls.
 */
export async function createCostCorrection(request, env) {
  const b = await readJson(request);
  const reason = String(b.reason || '').trim();
  if (reason.length < 10) throw new ApiError(400, 'bad_payload', 'A cost correction needs a reason of at least 10 characters');
  const weeks = Array.isArray(b.weeks) ? b.weeks : [];
  if (!weeks.length || weeks.length > 60) throw new ApiError(400, 'bad_payload', 'weeks: 1–60 entries { weekStart, fromCatalogRev, toCatalogRev }');
  const seen = new Set(), REV = /^cat_[0-9a-f]{16}$/;
  for (const w of weeks) {
    if (!WEEK_RE.test(w?.weekStart || '') || weekStartOf(w.weekStart) !== w.weekStart || seen.has(w.weekStart)) throw new ApiError(400, 'bad_payload', 'each weekStart must be a distinct Monday');
    if (!REV.test(w.fromCatalogRev || '') || !REV.test(w.toCatalogRev || '') || w.fromCatalogRev === w.toCatalogRev) throw new ApiError(400, 'bad_payload', 'fromCatalogRev and toCatalogRev must be two catalog revisions');
    seen.add(w.weekStart);
  }
  const db = env.DB;
  // Each week's current catalog must be the stated original.
  for (const w of weeks) {
    const cur = await db.prepare(`SELECT COALESCE((SELECT catalog_rev FROM snapshot WHERE week_start = ?1 AND status = 'published'),
        (SELECT catalog_rev FROM snapshot WHERE week_start = ?1 ORDER BY revision DESC LIMIT 1)) AS rev`).bind(w.weekStart).first();
    if (!cur?.rev) throw new ApiError(409, 'week_has_no_snapshot', `The week of ${w.weekStart} has no snapshot to correct`);
    if (cur.rev !== w.fromCatalogRev) throw new ApiError(409, 'not_original_catalog', `The week of ${w.weekStart} is on ${cur.rev}, not ${w.fromCatalogRev}`);
  }
  // Each corrected catalog: accepted, holding the MCG table, otherwise identical to its original.
  const pairs = [...new Set(weeks.map(w => `${w.fromCatalogRev}>${w.toCatalogRev}`))].map(x => x.split('>'));
  for (const [from, to] of pairs) {
    const cat = await db.prepare('SELECT status FROM cost_catalog WHERE catalog_rev = ?1').bind(to).first();
    if (cat?.status !== 'accepted') throw new ApiError(409, 'catalog_not_accepted', `${to} is not an accepted catalog`);
    const pack = await db.prepare(`SELECT (SELECT group_concat(payload, '' ORDER BY part) FROM cost_catalog_part WHERE catalog_rev = ?1 AND table_name = ?3) AS a,
        (SELECT group_concat(payload, '' ORDER BY part) FROM cost_catalog_part WHERE catalog_rev = ?2 AND table_name = ?3) AS b`).bind(from, to, MCG_TABLE).first();
    if (!pack?.b || pack.b === '{}') throw new ApiError(409, 'no_mcg_table', `${to} has no MCG pack table`);
    if (pack.a === pack.b) throw new ApiError(409, 'mcg_table_unchanged', `${to} has the same MCG pack table as ${from}`);
    const d = await db.prepare(CATALOG_DIFF_EXCEPT_SQL).bind(from, to, MCG_TABLE).first();
    if ((d?.n ?? 1) !== 0) throw new ApiError(409, 'catalog_changes_more_than_mcg', `${to} differs from ${from} outside the MCG pack table (${d?.n} entries)`);
  }
  const actor = actorFor('admin_secret', b);
  const id = newId('ccr'), at = nowIso();
  await atomic(db, [
    db.prepare('INSERT INTO cost_correction (correction_id, reason, actor_class, actor_label, at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(id, reason, actor.cls, actor.label, at),
    ...weeks.map(w => db.prepare('INSERT INTO cost_correction_week (correction_id, week_start, from_catalog_rev, to_catalog_rev) VALUES (?1, ?2, ?3, ?4)')
      .bind(id, w.weekStart, w.fromCatalogRev, w.toCatalogRev)),
  ]);
  return json({ correctionId: id, at, weeks: weeks.map(w => ({ weekStart: w.weekStart, fromCatalogRev: w.fromCatalogRev, toCatalogRev: w.toCatalogRev })),
                note: 'Each named week gets a new revision on its corrected catalog on the next collector run; earlier revisions are kept.' });
}
export async function listCostCorrections(env) {
  const [c, w] = await env.DB.batch([env.DB.prepare('SELECT * FROM cost_correction ORDER BY at DESC LIMIT 100'),
    env.DB.prepare('SELECT * FROM cost_correction_week ORDER BY week_start')]);
  const weeks = w.results || [];
  return json({ corrections: (c.results || []).map(({ actor_class, actor_label, ...r }) => ({ ...r, actorClass: actor_class, actorLabel: actor_label,
    weeks: weeks.filter(x => x.correction_id === r.correction_id).map(x => ({ weekStart: x.week_start, fromCatalogRev: x.from_catalog_rev, toCatalogRev: x.to_catalog_rev })) })) });
}

/** Upsert of a week's unchanged-week check (only when something in it changed or it is 3 hours old). */
export const MANIFEST_CHECK_UPSERT = `INSERT INTO manifest_check (week_start, m_epoch, env_sig, snapshot_id, published_id, prev_published_id, checked_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    ON CONFLICT(week_start) DO UPDATE SET m_epoch = excluded.m_epoch, env_sig = excluded.env_sig, snapshot_id = excluded.snapshot_id,
      published_id = excluded.published_id, prev_published_id = excluded.prev_published_id, checked_at = excluded.checked_at
    WHERE manifest_check.m_epoch IS NOT excluded.m_epoch OR manifest_check.env_sig IS NOT excluded.env_sig OR manifest_check.snapshot_id IS NOT excluded.snapshot_id
       OR manifest_check.published_id IS NOT excluded.published_id OR manifest_check.prev_published_id IS NOT excluded.prev_published_id
       OR manifest_check.checked_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 hours')`;

/**
 * The Worker settings a manifest depends on besides D1 (engine and variables): part of the
 * unchanged-week shortcut's key, so a deploy or a variable change re-checks every week.
 */
const manifestEnvSig = env => `${ENGINE_VERSION}|${env.PUBLICATION_ALLOWED === 'true'}|${reportingStartOf(env) || ''}`;

export async function getManifest(env, weekStart) {
  if (!WEEK_RE.test(weekStart) || weekStartOf(weekStart) !== weekStart) throw new ApiError(400, 'bad_query', 'week must be a Monday (YYYY-MM-DD)');
  // Unchanged-week shortcut (migration 0021): when the last full check found this week's newest revision
  // computed from exactly its inputs, no manifest input other than snapshots was written since (same m
  // counter), the snapshots the manifest reads are the same (the week's newest and published revisions,
  // the prior week's published one), the engine and variables are the same and the check is recent, the
  // answer is the same: no manifest is assembled (≈8.6k rows read per week saved on every retry).
  const db = env.DB, envSig = manifestEnvSig(env), prevWeek = addDays(weekStart, -7);
  const [er, cr, lr, pr, qr] = await db.batch([
    db.prepare('SELECT n, m FROM input_epoch WHERE id = 1'),
    db.prepare('SELECT m_epoch, env_sig, snapshot_id, published_id, prev_published_id, checked_at FROM manifest_check WHERE week_start = ?1').bind(weekStart),
    db.prepare('SELECT snapshot_id, revision, status, storage FROM snapshot WHERE week_start = ?1 ORDER BY revision DESC LIMIT 1').bind(weekStart),
    db.prepare("SELECT snapshot_id FROM snapshot WHERE week_start = ?1 AND status = 'published'").bind(weekStart),
    db.prepare("SELECT snapshot_id FROM snapshot WHERE week_start = ?1 AND status = 'published'").bind(prevWeek),
  ]);
  const cnt = er.results?.[0], chk = cr.results?.[0], last = lr.results?.[0];
  const pubId = pr.results?.[0]?.snapshot_id ?? null, prevPubId = qr.results?.[0]?.snapshot_id ?? null;
  if (chk && last && cnt && chk.m_epoch === cnt.m && chk.env_sig === envSig && chk.snapshot_id === last.snapshot_id && last.storage === 'chunked'
      && (chk.published_id ?? null) === pubId && (chk.prev_published_id ?? null) === prevPubId
      && Date.now() - Date.parse(chk.checked_at) <= MANIFEST_MAX_AGE_MS) {
    return json({ existing: { snapshotId: last.snapshot_id, revision: last.revision, status: last.status }, epoch: cnt.n, shortcut: true });
  }
  const { manifest, epoch, mEpoch, anchorIds, latestSnapshot: latest, ordersText } = await assemble(env, weekStart, { rawOrders: true });
  const [manifestHash, inputsHash] = await manifestHashes(manifest, ordersText);
  // The week's newest revision was computed from exactly these inputs: nothing to do (a retry or re-run writes 0 rows).
  const existing = latest?.storage === 'chunked' && latest.manifest_hash === inputsHash
    ? { snapshotId: latest.snapshot_id, revision: latest.revision, status: latest.status } : null;
  // Remember the verdict with the counter and snapshot ids read in the manifest's first batch (a write
  // during assembly moves the counter, so the next request checks again). Not an input: it moves nothing.
  if (existing && mEpoch !== null) await db.prepare(MANIFEST_CHECK_UPSERT).bind(weekStart, mEpoch, envSig, existing.snapshotId, anchorIds.published, anchorIds.prevPublished, nowIso()).run();
  const body = JSON.stringify({ manifest, manifestHash, epoch, signature: await signManifest(env, manifestHash, epoch), existing });
  return manifest.orders === RAW_ORDERS ? jsonText(body.replace('{"rawOrders":true}', () => ordersText)) : jsonText(body);
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

// Columns whose TEXT value is itself JSON: it must parse, and its nested keys get the customer-field walk.
const JSON_TEXT = new Set(['flags', 'detail', 'labels', 'revenue_bridge', 'policy', 'draft_comparison']);
const SCENARIO_BOOLEAN = new Set(['missingCost', 'isRoute', 'isGiftCard', 'isInfluencerSample']);
const SCENARIO_NUMBER = new Set(['qty', 'unitPrice', 'baseMerchRevenue', 'lineRevenue', 'lineCogs', 'shipCollected', 'shipPaid']);
const invalid = what => new ApiError(400, 'part_invalid', what);
const noCustomer = v => { try { assertNoCustomerFields(v); } catch { throw new ApiError(400, 'customer_data_rejected', 'A result part contains customer fields'); } };
/**
 * A value of a stored result column: null, a string or a finite number, never an object or array.
 * A JSON-text column must hold JSON text (or null) whose nested data carries no customer field.
 */
function checkValue(k, x, what) {
  if (x === null) return;
  if (typeof x === 'number') { if (!Number.isFinite(x)) throw invalid(`${what}.${k} must be a finite number`); return; }
  if (typeof x !== 'string') throw invalid(`${what}.${k} must be a string, a number or null`);
  if (JSON_TEXT.has(k)) { let j; try { j = JSON.parse(x); } catch { throw invalid(`${what}.${k} must be JSON text`); } noCustomer(j); }
}
function rowsExactly(rows, keys, what, check = checkValue) {
  if (!Array.isArray(rows)) throw invalid(`${what} must be an array`);
  for (const r of rows) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw invalid(`${what} rows must be objects`);
    const k = Object.keys(r);
    if (k.length !== keys.size || k.some(x => !keys.has(x))) throw invalid(`${what} rows must have exactly the approved columns`);
    for (const c of k) check(c, r[c], what);
  }
}
/** Scenario lines: the calculator's fields with their exact primitive types. */
function checkScenarioValue(k, x, what) {
  if (SCENARIO_BOOLEAN.has(k)) { if (typeof x !== 'boolean') throw invalid(`${what}.${k} must be true or false`); return; }
  if (SCENARIO_NUMBER.has(k)) { if (x !== null && !(typeof x === 'number' && Number.isFinite(x))) throw invalid(`${what}.${k} must be a number or null`); return; }
  if (x !== null && typeof x !== 'string') throw invalid(`${what}.${k} must be a string or null`);
}
function validatePart(name, v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid('Part must be a JSON object');
  const only = keys => { if (Object.keys(v).length !== keys.length || keys.some(k => !(k in v))) throw invalid(`Part must have exactly ${keys.join(', ')}`); };
  if (name === 'orderindex') {
    only(['orders']);
    if (!Array.isArray(v.orders) || v.orders.some(t => !Array.isArray(t) || t.length !== ORDER_INDEX_FIELDS.length || typeof t[0] !== 'string' || !Number.isInteger(t[1]) || t[1] < 0
        || t.slice(2).some(x => x !== null && typeof x !== 'string' && !(typeof x === 'number' && Number.isFinite(x))))) throw invalid('orderindex.orders must be order tuples of strings, numbers and nulls');
  } else if (name.startsWith('orders:')) {
    only(['orders']);
    rowsExactly(v.orders, ORDER_KEYS, 'orders');
    if (v.orders.length > ORDERS_PER_PART) throw invalid(`At most ${ORDERS_PER_PART} orders per part`);
  } else if (name === 'sections') {
    only(['breakdowns', 'reconciliation', 'issues', 'shippingC3']);
    rowsExactly(v.breakdowns, BD_KEYS, 'breakdowns'); rowsExactly(v.reconciliation, RECON_KEYS, 'reconciliation'); rowsExactly(v.issues, ISSUE_KEYS, 'issues');
    noCustomer(v.shippingC3 ?? null);                                // the one free-form object: walked whole
  } else if (name.startsWith('scenario:')) {
    only(['lines']);
    rowsExactly(v.lines, SCENARIO_KEYS, 'scenario.lines', checkScenarioValue);
  } else { only(['lines']); rowsExactly(v.lines, LINE_KEYS, 'lines'); }
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
  // Head and totals are stored as columns: the same value rules as result rows (JSON text walked).
  try { for (const [k, x] of Object.entries(head)) checkValue(k, x, 'index.head'); for (const [k, x] of Object.entries(totals)) checkValue(k, x, 'index.totals'); }
  catch (e) { if (e instanceof ApiError) throw new ApiError(400, e.code === 'customer_data_rejected' ? e.code : 'bad_payload', e.message); throw e; }
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
  // Order and line parts also keep their validated text: order lists and details run in D1 over it.
  await db.prepare('INSERT OR IGNORE INTO snapshot_blob (snapshot_id, part, sha256, body, body_text) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(id, name, want, bytes, /^(orders|lines):/.test(name) ? text : null).run();
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
    db.prepare('SELECT n, aux_n FROM input_epoch WHERE id = 1'),
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
  // Every Worker-owned fact the gate was evaluated with is recorded, so the verifier can re-evaluate it
  // with its own recomputed totals, reconciliation and C3 shipping (the collector-supplied gate inputs).
  const gateRecord = { ...gate, sources, shippingReport: basis, ordersInOtherTimezone, storeTimezone: settings.store_timezone, storeTimezoneConfirmed: settings.store_timezone_confirmed === true,
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
    // The new revision is computed from exactly the week's current inputs (checked above, inside this
    // transaction): record the unchanged-week check with the m counter read in the same transaction, so the
    // next run's manifest for this week answers "existing" without assembling it.
    db.prepare(`INSERT INTO manifest_check (week_start, m_epoch, env_sig, snapshot_id, published_id, prev_published_id, checked_at)
        SELECT ?1, (SELECT m FROM input_epoch WHERE id = 1), ?2, ?3,
               (SELECT snapshot_id FROM snapshot WHERE week_start = ?1 AND status = 'published'),
               (SELECT snapshot_id FROM snapshot WHERE week_start = ?4 AND status = 'published'), ?5 WHERE 1
        ON CONFLICT(week_start) DO UPDATE SET m_epoch = excluded.m_epoch, env_sig = excluded.env_sig, snapshot_id = excluded.snapshot_id,
          published_id = excluded.published_id, prev_published_id = excluded.prev_published_id, checked_at = excluded.checked_at`)
      .bind(u.week_start, manifestEnvSig(env), id, addDays(u.week_start, -7), at),
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
