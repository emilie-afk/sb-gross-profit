/**
 * store.js — normalized records ⇄ D1
 * ==================================
 * Writes are idempotent: every record carries a content hash, and an unchanged
 * record is counted as a duplicate and not rewritten. Reads rebuild exactly the
 * normalized shapes shared/ produces, so a snapshot computed from D1 equals a
 * snapshot computed from the original payload.
 */
import { contentHash, weekStartOf, assertNoCustomerFields } from '../../shared/normalized.js';
import { jsonInsert, jsonDeleteIn, selectIn, atomic, nowIso } from './db.js';

const J = v => JSON.stringify(v ?? null);
const P = (s, d) => { try { return s === null || s === undefined ? d : JSON.parse(s); } catch { return d; } };
const bool = v => v === 1 || v === true || v === '1';
const IN = 'SELECT value FROM json_each(?1)';

// ─── Shopify orders ───────────────────────────────────────────────────────────

const ORDER_COLS = ['order_name', 'order_number', 'shopify_id', 'created_at', 'created_at_local', 'business_date', 'week_start',
  'cancelled_at', 'subtotal', 'shipping', 'taxes', 'total', 'duties', 'discount_amount', 'refunded_amount', 'discount_codes',
  'source_name', 'tags', 'note_attributes', 'store', 'source_system', 'content_hash', 'ingest_run_id', 'ingested_at', 'normalized_timezone'];
const LINE_COLS = ['order_name', 'line_index', 'line_id', 'sku', 'product_name', 'quantity', 'current_quantity', 'unit_price',
  'vendor', 'requires_shipping', 'line_discount', 'discount_source'];
const ALLOC_COLS = ['order_name', 'line_index', 'alloc_index', 'amount', 'application_type', 'application_index',
  'allocation_method', 'target_selection', 'target_type', 'code', 'title'];
const REFUND_COLS = ['refund_id', 'order_name', 'processed_at', 'amount', 'refund_source'];
const RLINE_COLS = ['refund_id', 'seq', 'line_index', 'line_id', 'quantity', 'subtotal', 'tax'];
const RSHIP_COLS = ['refund_id', 'seq', 'subtotal', 'tax'];
const RADJ_COLS = ['refund_id', 'seq', 'amount', 'tax', 'reason'];

export async function saveOrders(db, orders, runId, { timeZone } = {}) {
  if (!timeZone) throw new Error('saveOrders needs the store time zone the orders were normalized under');
  assertNoCustomerFields(orders);
  for (const o of orders) {
    if (!o.orderName || !o.businessDate || !Array.isArray(o.lines)) {
      throw Object.assign(new Error(`Order ${o.orderName || '(unnamed)'} is missing orderName, businessDate or lines`), { code: 'bad_payload' });
    }
  }
  const hashes = await Promise.all(orders.map(o => contentHash(o)));
  const existing = new Map((await selectIn(db, `SELECT order_name, content_hash FROM shopify_order WHERE order_name IN (${IN})`,
    orders.map(o => o.orderName))).map(r => [r.order_name, r.content_hash]));
  const changed = orders.map((o, i) => ({ o, h: hashes[i] })).filter(x => existing.get(x.o.orderName) !== x.h);
  if (!changed.length) return { written: 0, duplicates: orders.length, weeks: [], weeksTouched: {} };

  const at = nowIso(), names = changed.map(x => x.o.orderName);
  const orderRows = [], lineRows = [], allocRows = [], refundRows = [], rlRows = [], rsRows = [], raRows = [];
  for (const { o, h } of changed) {
    orderRows.push({ order_name: o.orderName, order_number: o.orderNumber, shopify_id: o.shopifyId, created_at: o.createdAt,
      created_at_local: o.createdAtLocal, business_date: o.businessDate, week_start: weekStartOf(o.businessDate),
      cancelled_at: o.cancelledAt, subtotal: o.subtotal, shipping: o.shipping, taxes: o.taxes, total: o.total, duties: o.duties,
      discount_amount: o.discountAmount, refunded_amount: o.refundedAmount, discount_codes: J(o.discountCodes || []),
      source_name: o.sourceName, tags: J(o.tags || []), note_attributes: J(o.noteAttributes || []), store: o.store,
      source_system: o.sourceSystem, content_hash: h, ingest_run_id: runId, ingested_at: at, normalized_timezone: timeZone,
      fulfillment_status: o.fulfillmentStatus ?? null, fulfilled_at: o.fulfilledAt ?? null });
    for (const l of o.lines) {
      lineRows.push({ order_name: o.orderName, line_index: l.lineIndex, line_id: l.lineId, sku: l.sku, product_name: l.productName,
        quantity: l.quantity, current_quantity: l.currentQuantity, unit_price: l.unitPrice, vendor: l.vendor,
        requires_shipping: l.requiresShipping === null || l.requiresShipping === undefined ? null : String(l.requiresShipping),
        line_discount: l.lineDiscount, discount_source: l.discountSource || 'none', fulfillment_status: l.fulfillmentStatus ?? null });
      (l.discountAllocations || []).forEach((a, k) => allocRows.push({ order_name: o.orderName, line_index: l.lineIndex, alloc_index: k,
        amount: a.amount, application_type: a.applicationType, application_index: a.applicationIndex, allocation_method: a.allocationMethod,
        target_selection: a.targetSelection, target_type: a.targetType, code: a.code, title: a.title }));
    }
    for (const rf of o.refunds || []) {
      refundRows.push({ refund_id: rf.refundId, order_name: o.orderName, processed_at: rf.processedAt, amount: rf.amount, refund_source: rf.refundSource });
      (rf.lines || []).forEach((x, k) => rlRows.push({ refund_id: rf.refundId, seq: k, line_index: x.lineIndex, line_id: x.lineId, quantity: x.quantity, subtotal: x.subtotal, tax: x.tax }));
      (rf.shippingLines || []).forEach((x, k) => rsRows.push({ refund_id: rf.refundId, seq: k, subtotal: x.subtotal, tax: x.tax }));
      (rf.adjustments || []).forEach((x, k) => raRows.push({ refund_id: rf.refundId, seq: k, amount: x.amount, tax: x.tax, reason: x.reason }));
    }
  }
  const refundOfOrders = `SELECT refund_id FROM shopify_refund WHERE order_name IN (${IN})`;
  const del = (table, via) => chunked(names, chunk => db.prepare(`DELETE FROM ${table} WHERE refund_id IN (${via})`).bind(JSON.stringify(chunk)));
  await atomic(db, [
    ...jsonDeleteIn(db, 'shopify_discount_allocation', 'order_name', names),
    ...del('shopify_refund_line', refundOfOrders),
    ...del('shopify_refund_shipping_line', refundOfOrders),
    ...del('shopify_order_adjustment', refundOfOrders),
    ...jsonDeleteIn(db, 'shopify_refund', 'order_name', names),
    ...jsonDeleteIn(db, 'shopify_order_line', 'order_name', names),
    ...jsonInsert(db, 'shopify_order', ORDER_COLS, orderRows),
    ...jsonInsert(db, 'shopify_order_line', LINE_COLS, lineRows),
    ...jsonInsert(db, 'shopify_discount_allocation', ALLOC_COLS, allocRows),
    ...jsonInsert(db, 'shopify_refund', REFUND_COLS, refundRows),
    ...jsonInsert(db, 'shopify_refund_line', RLINE_COLS, rlRows),
    ...jsonInsert(db, 'shopify_refund_shipping_line', RSHIP_COLS, rsRows),
    ...jsonInsert(db, 'shopify_order_adjustment', RADJ_COLS, raRows),
  ]);
  const weeksTouched = {};
  for (const r of orderRows) weeksTouched[r.week_start] = (weeksTouched[r.week_start] || 0) + 1;
  return { written: changed.length, duplicates: orders.length - changed.length,
           weeks: Object.keys(weeksTouched).sort(), weeksTouched };
}

/** { weekStart: count } of stored Shopify orders with these order numbers (for shipments / HPD rows that changed). */
export async function weeksOfOrderNumbers(db, orderNumbers) {
  const out = {};
  if (!orderNumbers.length) return out;
  for (const r of await selectIn(db, `SELECT week_start, COUNT(*) AS n FROM shopify_order WHERE order_number IN (${IN}) GROUP BY week_start`,
    [...new Set(orderNumbers)])) out[r.week_start] = (out[r.week_start] || 0) + r.n;
  return out;
}

function chunked(values, make) {
  const out = [];
  for (let i = 0; i < values.length; i += 5000) out.push(make(values.slice(i, i + 5000)));
  return out;
}

export async function loadOrdersForWeek(db, weekStart) {
  const orders = (await db.prepare('SELECT * FROM shopify_order WHERE week_start = ?1 ORDER BY created_at_local, order_name').bind(weekStart).all()).results || [];
  return assembleOrders(db, orders);
}

export async function loadOrdersByName(db, names) {
  return assembleOrders(db, await selectIn(db, `SELECT * FROM shopify_order WHERE order_name IN (${IN}) ORDER BY created_at_local, order_name`, names));
}

async function assembleOrders(db, orders) {
  if (!orders.length) return [];
  const names = orders.map(o => o.order_name);
  const lines = await selectIn(db, `SELECT * FROM shopify_order_line WHERE order_name IN (${IN}) ORDER BY order_name, line_index`, names);
  const allocs = await selectIn(db, `SELECT * FROM shopify_discount_allocation WHERE order_name IN (${IN}) ORDER BY order_name, line_index, alloc_index`, names);
  const refunds = await selectIn(db, `SELECT * FROM shopify_refund WHERE order_name IN (${IN}) ORDER BY order_name, refund_id`, names);
  const rids = refunds.map(r => r.refund_id);
  const rl = rids.length ? await selectIn(db, `SELECT * FROM shopify_refund_line WHERE refund_id IN (${IN}) ORDER BY refund_id, seq`, rids) : [];
  const rs = rids.length ? await selectIn(db, `SELECT * FROM shopify_refund_shipping_line WHERE refund_id IN (${IN}) ORDER BY refund_id, seq`, rids) : [];
  const ra = rids.length ? await selectIn(db, `SELECT * FROM shopify_order_adjustment WHERE refund_id IN (${IN}) ORDER BY refund_id, seq`, rids) : [];
  const group = (arr, k) => arr.reduce((m, r) => { (m.get(r[k]) || m.set(r[k], []).get(r[k])).push(r); return m; }, new Map());
  const L = group(lines, 'order_name'), A = group(allocs, 'order_name'), R = group(refunds, 'order_name');
  const RL = group(rl, 'refund_id'), RS = group(rs, 'refund_id'), RA = group(ra, 'refund_id');
  return orders.map(o => ({
    orderName: o.order_name, orderNumber: o.order_number, shopifyId: o.shopify_id, createdAt: o.created_at,
    createdAtLocal: o.created_at_local, businessDate: o.business_date, cancelledAt: o.cancelled_at,
    subtotal: o.subtotal, shipping: o.shipping, taxes: o.taxes, total: o.total, duties: o.duties,
    discountAmount: o.discount_amount, refundedAmount: o.refunded_amount, discountCodes: P(o.discount_codes, []),
    sourceName: o.source_name, tags: P(o.tags, []), noteAttributes: P(o.note_attributes, []), store: o.store,
    sourceSystem: o.source_system,
    ...(o.fulfillment_status != null ? { fulfillmentStatus: o.fulfillment_status } : {}),
    ...(o.fulfilled_at != null ? { fulfilledAt: o.fulfilled_at } : {}),
    lines: (L.get(o.order_name) || []).map(l => ({
      lineIndex: l.line_index, lineId: l.line_id, sku: l.sku, productName: l.product_name, quantity: l.quantity,
      currentQuantity: l.current_quantity, unitPrice: l.unit_price, vendor: l.vendor, requiresShipping: l.requires_shipping,
      lineDiscount: l.line_discount, discountSource: l.discount_source,
      ...(l.fulfillment_status != null ? { fulfillmentStatus: l.fulfillment_status } : {}),
      discountAllocations: (A.get(o.order_name) || []).filter(a => a.line_index === l.line_index).map(a => ({
        amount: a.amount, applicationType: a.application_type, applicationIndex: a.application_index,
        allocationMethod: a.allocation_method, targetSelection: a.target_selection, targetType: a.target_type,
        code: a.code, title: a.title })),
    })),
    refunds: (R.get(o.order_name) || []).map(rf => ({
      refundId: rf.refund_id, processedAt: rf.processed_at, amount: rf.amount, refundSource: rf.refund_source,
      lines: (RL.get(rf.refund_id) || []).map(x => ({ lineId: x.line_id, lineIndex: x.line_index, quantity: x.quantity, subtotal: x.subtotal, tax: x.tax })),
      shippingLines: (RS.get(rf.refund_id) || []).map(x => ({ subtotal: x.subtotal, tax: x.tax })),
      adjustments: (RA.get(rf.refund_id) || []).map(x => ({ amount: x.amount, tax: x.tax, reason: x.reason })),
    })),
  }));
}

// ─── Shipments ────────────────────────────────────────────────────────────────

const SHIP_COLS = ['shipment_no', 'order_number', 'tracking_number', 'ship_date', 'modify_date', 'voided', 'void_date', 'carrier',
  'service', 'provider', 'carrier_fee', 'legacy_rate', 'insurance_cost', 'shipping_paid', 'carrier_txn_id', 'internal_txn_id',
  'external_id', 'no_postage', 'created_by_class', 'store_name', 'package_count', 'weight', 'fields_present', 'issues',
  'source_format', 'content_hash', 'ingest_run_id', 'ingested_at'];
const ITEM_COLS = ['shipment_no', 'item_index', 'sku', 'quantity'];

export async function saveShipments(db, shipments, runId) {
  const hashes = await Promise.all(shipments.map(s => contentHash(s)));
  const existing = new Map((await selectIn(db, `SELECT shipment_no, content_hash FROM shipment WHERE shipment_no IN (${IN})`,
    shipments.map(s => s.shipmentNo))).map(r => [r.shipment_no, r.content_hash]));
  const changed = shipments.map((s, i) => ({ s, h: hashes[i] })).filter(x => existing.get(x.s.shipmentNo) !== x.h);
  if (!changed.length) return { written: 0, duplicates: shipments.length, weeksTouched: {} };
  const at = nowIso();
  const rows = changed.map(({ s, h }) => ({
    shipment_no: s.shipmentNo, order_number: s.orderNumber, tracking_number: s.trackingNumber, ship_date: s.shipDate,
    modify_date: s.modifyDate, voided: s.voided ? 1 : 0, void_date: s.voidDate, carrier: s.carrier, service: s.service,
    provider: s.provider, carrier_fee: s.carrierFee, legacy_rate: s.legacyRate, insurance_cost: s.insuranceCost,
    shipping_paid: s.shippingPaid, carrier_txn_id: s.carrierTxnId, internal_txn_id: s.internalTxnId, external_id: s.externalId,
    no_postage: s.noPostage ? 1 : 0, created_by_class: s.createdByClass || null, store_name: s.storeName, package_count: s.packageCount,
    weight: s.weight, fields_present: J(s.fieldsPresent || {}), issues: J(s.issues || []), source_format: s.sourceFormat,
    content_hash: h, ingest_run_id: runId, ingested_at: at }));
  const items = changed.flatMap(({ s }) => (s.items || []).map(it => ({ shipment_no: s.shipmentNo, item_index: it.itemIndex, sku: it.sku, quantity: it.quantity })));
  const nos = changed.map(x => x.s.shipmentNo);
  await atomic(db, [
    ...jsonDeleteIn(db, 'shipment_item', 'shipment_no', nos),
    ...jsonInsert(db, 'shipment', SHIP_COLS, rows),
    ...jsonInsert(db, 'shipment_item', ITEM_COLS, items),
  ]);
  return { written: changed.length, duplicates: shipments.length - changed.length,
           weeksTouched: await weeksOfOrderNumbers(db, changed.map(x => x.s.orderNumber)) };
}

export async function loadShipmentsForOrders(db, orderNumbers) {
  if (!orderNumbers.length) return [];
  const ships = await selectIn(db, `SELECT * FROM shipment WHERE order_number IN (${IN}) ORDER BY shipment_no`, orderNumbers);
  const items = ships.length ? await selectIn(db, `SELECT * FROM shipment_item WHERE shipment_no IN (${IN}) ORDER BY shipment_no, item_index`,
    ships.map(s => s.shipment_no)) : [];
  const byShip = items.reduce((m, r) => { (m.get(r.shipment_no) || m.set(r.shipment_no, []).get(r.shipment_no)).push(r); return m; }, new Map());
  return ships.map(s => ({
    shipmentNo: s.shipment_no, orderNumber: s.order_number, trackingNumber: s.tracking_number, shipDate: s.ship_date,
    modifyDate: s.modify_date, voided: bool(s.voided), voidDate: s.void_date, carrier: s.carrier, service: s.service,
    provider: s.provider, carrierFee: s.carrier_fee, legacyRate: s.legacy_rate, insuranceCost: s.insurance_cost,
    shippingPaid: s.shipping_paid, carrierTxnId: s.carrier_txn_id, internalTxnId: s.internal_txn_id, externalId: s.external_id,
    noPostage: bool(s.no_postage), createdByClass: s.created_by_class, storeName: s.store_name, packageCount: s.package_count,
    weight: s.weight, sourceFormat: s.source_format, fieldsPresent: P(s.fields_present, {}), issues: P(s.issues, []),
    items: (byShip.get(s.shipment_no) || []).map(i => ({ itemIndex: i.item_index, sku: i.sku, quantity: i.quantity })),
  }));
}

// ─── HPD ──────────────────────────────────────────────────────────────────────

const HPD_COLS = ['shopify_order_number', 'hpd_order_number', 'order_date', 'carrier_service', 'net_terms', 'prepaid',
  'cost_difference', 'content_hash', 'ingest_run_id', 'ingested_at'];

export async function saveHpd(db, hpdOrders, runId) {
  const hashes = await Promise.all(hpdOrders.map(h => contentHash(h)));
  const existing = new Map((await selectIn(db, `SELECT shopify_order_number, content_hash FROM hpd_order WHERE shopify_order_number IN (${IN})`,
    hpdOrders.map(h => h.shopifyOrderNumber))).map(r => [r.shopify_order_number, r.content_hash]));
  const changed = hpdOrders.map((h, i) => ({ h, hash: hashes[i] })).filter(x => existing.get(x.h.shopifyOrderNumber) !== x.hash);
  if (!changed.length) return { written: 0, duplicates: hpdOrders.length, weeksTouched: {} };
  const at = nowIso();
  const rows = changed.map(({ h, hash }) => ({ shopify_order_number: h.shopifyOrderNumber, hpd_order_number: h.hpdOrderNumber,
    order_date: h.orderDate, carrier_service: h.carrierService, net_terms: h.netTerms, prepaid: h.prepaid,
    cost_difference: h.costDifference, content_hash: hash, ingest_run_id: runId, ingested_at: at }));
  const items = changed.flatMap(({ h }) => (h.items || []).map((it, k) => ({ shopify_order_number: h.shopifyOrderNumber, seq: k, sku: it.sku, qty: it.qty })));
  const keys = changed.map(x => x.h.shopifyOrderNumber);
  await atomic(db, [
    ...jsonDeleteIn(db, 'hpd_item', 'shopify_order_number', keys),
    ...jsonInsert(db, 'hpd_order', HPD_COLS, rows),
    ...jsonInsert(db, 'hpd_item', ['shopify_order_number', 'seq', 'sku', 'qty'], items),
  ]);
  return { written: changed.length, duplicates: hpdOrders.length - changed.length,
           weeksTouched: await weeksOfOrderNumbers(db, keys) };
}

export async function loadHpdForOrders(db, orderNumbers) {
  if (!orderNumbers.length) return [];
  const rows = await selectIn(db, `SELECT * FROM hpd_order WHERE shopify_order_number IN (${IN})`, orderNumbers);
  const items = rows.length ? await selectIn(db, `SELECT * FROM hpd_item WHERE shopify_order_number IN (${IN}) ORDER BY shopify_order_number, seq`,
    rows.map(r => r.shopify_order_number)) : [];
  return rows.map(r => ({ shopifyOrderNumber: r.shopify_order_number, hpdOrderNumber: r.hpd_order_number, orderDate: r.order_date,
    carrierService: r.carrier_service, netTerms: r.net_terms, prepaid: r.prepaid, costDifference: r.cost_difference,
    items: items.filter(i => i.shopify_order_number === r.shopify_order_number).map(i => ({ sku: i.sku, qty: i.qty })) }));
}

// ─── Cost catalogs ────────────────────────────────────────────────────────────

const PART_CHARS = 700_000;

export async function saveCatalog(db, { rev, candidate, validation, source, meta }) {
  const exists = await db.prepare('SELECT status FROM cost_catalog WHERE catalog_rev = ?1').bind(rev).first();
  if (exists) {
    // Same content pushed again (e.g. a sheet reverted): it is the current catalog again.
    if (exists.status === 'accepted') await db.prepare('UPDATE cost_catalog SET last_pushed_at = ?2 WHERE catalog_rev = ?1').bind(rev, nowIso()).run();
    return { duplicate: true, status: exists.status };
  }
  const stmts = [db.prepare(`INSERT INTO cost_catalog (catalog_rev, captured_at, source, status, reject_reasons, table_counts, vendor_counts, vendor_total, meta)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`).bind(rev, nowIso(), source, validation.accepted ? 'accepted' : 'rejected',
    J(validation.reasons), J(validation.counts.tableCounts), J(validation.counts.vendorCounts), validation.counts.vendorTotal, J(meta || {}))];
  if (validation.accepted) {
    const tables = { ...(candidate.tables || {}), __mcgExtra: candidate.mcgExtra || {}, __overrides: candidate.overrides || {} };
    for (const [name, value] of Object.entries(tables)) {
      const s = JSON.stringify(value ?? {});
      for (let p = 0, i = 0; i === 0 || i < s.length; p++, i += PART_CHARS) {
        stmts.push(db.prepare('INSERT INTO cost_catalog_part (catalog_rev, table_name, part, payload) VALUES (?1, ?2, ?3, ?4)')
          .bind(rev, name, p, s.slice(i, i + PART_CHARS)));
        if (s.length === 0) break;
      }
    }
  }
  await atomic(db, stmts);
  return { duplicate: false, status: validation.accepted ? 'accepted' : 'rejected' };
}

/**
 * C6d: register a pinned BASE catalog (the existing non-vendor cost tables).
 * Stored with status 'base': never the active catalog and never chosen for a
 * week by itself; the vendor overlay reads it. Identical content is a duplicate.
 */
export async function saveBaseCatalog(db, { rev, base, counts, meta }) {
  const exists = await db.prepare('SELECT status FROM cost_catalog WHERE catalog_rev = ?1').bind(rev).first();
  if (exists) return { duplicate: true, status: exists.status };
  const stmts = [db.prepare(`INSERT INTO cost_catalog (catalog_rev, captured_at, source, status, reject_reasons, table_counts, vendor_counts, vendor_total, meta)
    VALUES (?1, ?2, 'base_upload', 'base', '[]', ?3, '{}', 0, ?4)`).bind(rev, nowIso(), J(counts), J(meta || {}))];
  const tables = { ...(base.tables || {}), __mcgExtra: base.mcgExtra || {}, __overrides: base.overrides || {} };
  for (const [name, value] of Object.entries(tables)) {
    const s = JSON.stringify(value ?? {});
    for (let p = 0, i = 0; i === 0 || i < s.length; p++, i += PART_CHARS) {
      stmts.push(db.prepare('INSERT INTO cost_catalog_part (catalog_rev, table_name, part, payload) VALUES (?1, ?2, ?3, ?4)').bind(rev, name, p, s.slice(i, i + PART_CHARS)));
      if (s.length === 0) break;
    }
  }
  await atomic(db, stmts);
  return { duplicate: false, status: 'base' };
}

/** Catalog meta (never tables) for one revision, or null. */
export async function catalogMeta(db, rev) {
  const r = await db.prepare('SELECT status, source, meta FROM cost_catalog WHERE catalog_rev = ?1').bind(rev).first();
  return r ? { status: r.status, source: r.source, meta: P(r.meta, {}) } : null;
}

export async function latestAcceptedCatalogMeta(db) {
  return db.prepare("SELECT * FROM cost_catalog WHERE status = 'accepted' ORDER BY COALESCE(last_pushed_at, captured_at) DESC, catalog_rev LIMIT 1").first();
}

export async function loadCatalog(db, rev) {
  const parts = (await db.prepare('SELECT table_name, part, payload FROM cost_catalog_part WHERE catalog_rev = ?1 ORDER BY table_name, part').bind(rev).all()).results || [];
  const byTable = new Map();
  for (const p of parts) byTable.set(p.table_name, (byTable.get(p.table_name) || '') + p.payload);
  const tables = {};
  let mcgExtra = {}, overrides = {};
  for (const [name, s] of byTable) {
    const v = P(s, {});
    if (name === '__mcgExtra') mcgExtra = v; else if (name === '__overrides') overrides = v; else tables[name] = v;
  }
  return { rev, tables, mcgExtra, overrides };
}
