/**
 * bundle.js — a week's pinned input bundle → buildSnapshot() input
 * ================================================================
 * Free-tier path: the Worker pins a week's inputs in a MANIFEST (hashes and
 * small values only); the parts are content-addressed. The office PC
 * (collector) and the independent verifier fetch the parts, check every hash,
 * and build the exact buildSnapshot() input the Worker's own loaders would
 * build — then call the UNCHANGED engine.
 *
 * Each function mirrors one Worker loader; the parity tests prove it equal:
 *   storedOrderForm      ≡ store.js saveOrders → assembleOrders (the D1 round trip)
 *   weekOrdersFrom       ≡ loadOrdersForWeek (week filter + ORDER BY)
 *   catalogFromParts     ≡ loadCatalog
 *   scrDays.reportFromDays ≡ compute.js reportForWeek (date-level ownership)
 * No formula lives here. Pure apart from WebCrypto hashing.
 */
import { weekStartOf, stableStringify } from './normalized.js';
import { buildSnapshot, SHIPPING_SOURCES, ENGINE_VERSION } from './snapshot.js';
import { effectiveFromDays, reportFromDays, sha256Hex, dayHash } from './scrDays.js';
import { catalogRevOf, catalogPartsRevOf } from './catalog.js';

export const MANIFEST_VERSION = 3;   // 2: aux hashes over the served JSON; 3: bounded result parts (orders:k, orderindex, scenario:j)

// ─── SQLite column affinity, as D1 applies it on insert ────────────────────────
const nul = v => (v === undefined ? null : v);
const b01 = v => (typeof v === 'boolean' ? (v ? 1 : 0) : nul(v));
const NUMERIC_TEXT = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/;
const TEXT = v => { v = b01(v); return typeof v === 'number' ? String(v) : v; };
const NUM = v => { v = b01(v); return typeof v === 'string' && NUMERIC_TEXT.test(v) ? Number(v) : v; };
const J = v => JSON.stringify(v ?? null);
const P = (s, d) => { try { return s === null || s === undefined ? d : JSON.parse(s); } catch { return d; } };
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** One normalized order exactly as the Worker's D1 loaders return it (column affinity, sort orders, defaults). */
export function storedOrderForm(o) {
  const lineAllocs = new Map();
  for (const l of o.lines) lineAllocs.set(NUM(l.lineIndex), (l.discountAllocations || []).map(a => ({
    amount: NUM(a.amount), applicationType: TEXT(a.applicationType), applicationIndex: NUM(a.applicationIndex),
    allocationMethod: TEXT(a.allocationMethod), targetSelection: TEXT(a.targetSelection), targetType: TEXT(a.targetType),
    code: TEXT(a.code), title: TEXT(a.title) })));
  const lines = o.lines.map(l => ({ l, idx: NUM(l.lineIndex) })).sort((a, b) => a.idx - b.idx);
  const refunds = [...(o.refunds || [])].map(rf => ({ rf, id: TEXT(rf.refundId) })).sort((a, b) => cmp(a.id, b.id));
  const reqShip = v => (v === null || v === undefined ? null : String(v));
  const fs = o.fulfillmentStatus ?? null, fa = o.fulfilledAt ?? null;
  return {
    orderName: TEXT(o.orderName), orderNumber: TEXT(o.orderNumber), shopifyId: TEXT(o.shopifyId), createdAt: TEXT(o.createdAt),
    createdAtLocal: TEXT(o.createdAtLocal), businessDate: TEXT(o.businessDate), cancelledAt: TEXT(o.cancelledAt),
    subtotal: NUM(o.subtotal), shipping: NUM(o.shipping), taxes: NUM(o.taxes), total: NUM(o.total), duties: NUM(o.duties),
    discountAmount: NUM(o.discountAmount), refundedAmount: NUM(o.refundedAmount), discountCodes: P(J(o.discountCodes || []), []),
    sourceName: TEXT(o.sourceName), tags: P(J(o.tags || []), []), noteAttributes: P(J(o.noteAttributes || []), []), store: TEXT(o.store),
    sourceSystem: TEXT(o.sourceSystem),
    ...(fs != null ? { fulfillmentStatus: TEXT(fs) } : {}),
    ...(fa != null ? { fulfilledAt: TEXT(fa) } : {}),
    lines: lines.map(({ l, idx }) => ({
      lineIndex: idx, lineId: TEXT(l.lineId), sku: TEXT(l.sku), productName: TEXT(l.productName), quantity: NUM(l.quantity),
      currentQuantity: NUM(l.currentQuantity), unitPrice: NUM(l.unitPrice), vendor: TEXT(l.vendor), requiresShipping: reqShip(l.requiresShipping),
      lineDiscount: NUM(l.lineDiscount), discountSource: TEXT(l.discountSource || 'none'),
      ...(l.fulfillmentStatus != null ? { fulfillmentStatus: TEXT(l.fulfillmentStatus) } : {}),
      discountAllocations: lineAllocs.get(idx) || [],
    })),
    refunds: refunds.map(({ rf, id }) => ({
      refundId: id, processedAt: TEXT(rf.processedAt), amount: NUM(rf.amount), refundSource: TEXT(rf.refundSource),
      lines: (rf.lines || []).map(x => ({ lineId: TEXT(x.lineId), lineIndex: NUM(x.lineIndex), quantity: NUM(x.quantity), subtotal: NUM(x.subtotal), tax: NUM(x.tax) })),
      shippingLines: (rf.shippingLines || []).map(x => ({ subtotal: NUM(x.subtotal), tax: NUM(x.tax) })),
      adjustments: (rf.adjustments || []).map(x => ({ amount: NUM(x.amount), tax: NUM(x.tax), reason: TEXT(x.reason) })),
    })),
  };
}

/** The canonical string stored in ord_body (and its SHA-256 is the body hash). */
export const orderBodyString = o => stableStringify(storedOrderForm(o));

/** Stored orders of one business week, in loadOrdersForWeek order (created_at_local, order_name). */
export function weekOrdersFrom(storedOrders, weekStart) {
  return storedOrders.filter(o => weekStartOf(o.businessDate) === weekStart)
    .sort((a, b) => cmp(a.createdAtLocal, b.createdAtLocal) || cmp(a.orderName, b.orderName));
}

/** ≡ loadCatalog: parts [[tableName, part, payload]] → { rev, tables, mcgExtra, overrides } (tables in table_name order). */
export function catalogFromParts(rev, parts) {
  const byTable = new Map();
  for (const [name, , payload] of [...parts].sort((a, b) => cmp(a[0], b[0]) || a[1] - b[1])) byTable.set(name, (byTable.get(name) || '') + payload);
  const tables = {}; let mcgExtra = {}, overrides = {};
  for (const [name, s] of byTable) {
    const v = P(s, {});
    if (name === '__mcgExtra') mcgExtra = v; else if (name === '__overrides') overrides = v; else tables[name] = v;
  }
  return { rev, tables, mcgExtra, overrides };
}

export const manifestHash = m => sha256Hex(stableStringify(m));
/**
 * Hash of the shipments / HPD records exactly as the Worker serves them: native JSON, whose
 * key order is fixed by shipmentsFromRows / hpdFromRows and kept by any JSON round trip.
 * (The key-sorted form cost ~1.5 ms of Worker CPU per request at a full week.) A record
 * rebuilt in another key order does not match, and the week is refused, never mis-hashed.
 */
export const auxHash = v => sha256Hex(JSON.stringify(v ?? []));

const fail = (code, message) => Object.assign(new Error(message || code), { code });

/**
 * Check every part against the manifest and build the buildSnapshot() input.
 * @param manifest  the Worker's pinned manifest
 * @param parts     { orderBodies: Map(hash → string), dayGroups: Map(dayHash → groups),
 *                    catalogParts: [[table, part, payload]], shipments: [], hpdOrders: [] }
 */
export async function snapshotInputFromParts(manifest, parts) {
  if (manifest.v !== MANIFEST_VERSION) throw fail('manifest_version', 'Unknown manifest version');
  const orders = [];
  for (const [name, hash] of manifest.orders) {
    const s = parts.orderBodies.get(hash);
    if (s === undefined) throw fail('part_missing', 'An order body is missing');
    if (await sha256Hex(s) !== hash) throw fail('part_hash_mismatch', 'An order body does not match its hash');
    const o = JSON.parse(s);
    if (o.orderName !== name) throw fail('part_hash_mismatch', 'An order body belongs to another order');
    orders.push(o);
  }
  const days = [];
  for (const [date, , hash] of manifest.scrDays) {
    const groups = parts.dayGroups.get(hash);
    if (groups === undefined) throw fail('part_missing', 'A shipping-cost date is missing');
    if (await dayHash(date, groups) !== hash) throw fail('part_hash_mismatch', 'A shipping-cost date does not match its hash');
    days.push({ date, groups });
  }
  const cat = manifest.catalog;
  const catalogParts = parts.catalogParts.filter(x => cat.parts.some(([t, p]) => t === x[0] && p === x[1]));
  if (catalogParts.length !== cat.parts.length) throw fail('part_missing', 'A catalog part is missing');
  const catalog = catalogFromParts(cat.rev, catalogParts);
  // The catalog revision is content-addressed: the parts must hash back to it.
  // (Either definition: the content hash of a catalog pushed whole, or the parts hash of a chunked push.)
  if (await catalogRevOf({ tables: catalog.tables, mcgExtra: catalog.mcgExtra, overrides: catalog.overrides }) !== cat.rev
      && await catalogPartsRevOf(catalogParts) !== cat.rev) {
    throw fail('part_hash_mismatch', 'The catalog parts do not match the catalog revision');
  }
  if (await auxHash(parts.shipments) !== manifest.aux.shipmentsHash || await auxHash(parts.hpdOrders) !== manifest.aux.hpdHash) {
    throw fail('part_hash_mismatch', 'Shipments or HPD records do not match the manifest');
  }
  const weekOrders = weekOrdersFrom(orders, manifest.weekStart);
  const report = reportFromDays({ effective: effectiveFromDays(days), weekStart: manifest.weekStart, orders: weekOrders,
                                  knownReportKeys: manifest.knownReportKeys, previousShippingExpense: manifest.previousShippingExpense });
  const s = manifest.settings;
  return {
    weekStart: manifest.weekStart, orders: weekOrders, shipments: parts.shipments, hpdOrders: parts.hpdOrders,
    catalog,
    policy: { priority: ['carrierFee', 'legacyRate'], locked: s.carrier_fee_priority_locked === true,
              insuranceTreatment: s.insurance_treatment || 'awaiting_confirmation' },
    previous: manifest.previous, previousDraft: manifest.previousDraft,
    shippingSource: SHIPPING_SOURCES.REPORT, shippingCostReport: report.byOrder,
    c3: { asOf: manifest.asOf, policySettings: s, previousShippingExpense: report.previousShippingExpense,
          unmatchedReportOrders: report.unmatched, sourceVerified: s.shipping_cost_report_source_verified === true,
          catalogCompleteness: cat.completeness ?? null, provisionalEnabled: s.provisional_publication_enabled === true,
          shippingReportBasis: manifest.shippingReportBasis,
          publicationAllowed: s.publication_enabled === true && manifest.publicationAllowedEnv === true },
  };
}

/** Compute a week from its manifest and parts with the unchanged engine. Refuses a different engine version. */
export async function computeFromParts(manifest, parts) {
  if (manifest.engineVersion !== ENGINE_VERSION) throw fail('engine_version_mismatch', `This engine is ${ENGINE_VERSION}; the manifest pins ${manifest.engineVersion}`);
  return buildSnapshot(await snapshotInputFromParts(manifest, parts));
}
