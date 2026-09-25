/**
 * legacy.js — compatibility adapters between the normalized model and the engine
 * =============================================================================
 * calculate() has always consumed Shopify CSV rows keyed by their literal column
 * names. These adapters let every source feed that unchanged engine:
 *
 *   Shopify GraphQL ─┐
 *                    ├─► NormalizedOrder[] ─► toLegacyShopifyRows() ─► calculate()
 *   Shopify CSV ─────┘      (csvRowsToNormalizedOrders for backfill)
 *
 *   ShipStation export ─► NormalizedShipment[] ─► toLegacyShipStationCosts() ─► calculate()
 *   HPD shipping log   ─► NormalizedHpdOrder[] ─► toLegacyHpdMap()           ─► calculate()
 *
 * toLegacyShopifyRows() reproduces the Shopify CSV shape exactly, including the
 * detail that matters to the engine: order-level columns (Subtotal, Shipping,
 * Taxes, Total, Discount *, Refunded Amount, Cancelled at, Source, Tags, Note
 * Attributes) are written on an order's FIRST row only, as Shopify does.
 *
 * Literal CSV column names live in this file and in the manual-upload path only.
 * They are not part of any API response.
 */
import { normalizeOrderNumber } from '../calculator.js';
import {
  SOURCE_SYSTEMS, DISCOUNT_SOURCES, REFUND_SOURCES, toMoney, r2, orderNumberOf,
  parseCsvNoteAttributes, formatCsvNoteAttributes, businessDateOf, assertNoCustomerFields,
} from '../normalized.js';
import { selectShipmentExpense, DEFAULT_EXPENSE_POLICY } from './shipstation.js';

// ─── CSV → normalized (historical backfill) ───────────────────────────────────

/** "2026-09-15 10:04:12 -0700" → ISO instant, or null. */
function csvLocalToIso(s) {
  const m = String(s ?? '').trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*([+-]\d{2}):?(\d{2})$/);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}${m[3]}:${m[4]}`);
  return isNaN(d) ? null : d.toISOString();
}

const blankToNull = v => { const s = String(v ?? '').trim(); return s === '' ? null : s; };
const moneyOrNull = v => { const n = toMoney(v); return n === null ? null : r2(n); };
const intOrNull = v => { const s = String(v ?? '').trim(); if (s === '') return null; const n = parseInt(s, 10); return isNaN(n) ? null : n; };

/**
 * Shopify order-export rows → NormalizedOrder[].
 *
 * Customer columns (Email, Billing *, Shipping Name/Address/Phone, Phone, Notes)
 * are simply never read. Note attributes are reduced to the engine's two keys.
 */
export function csvRowsToNormalizedOrders(rows, { store = 'Succulents Box' } = {}) {
  const groups = new Map();
  for (const r of rows) {
    const name = String(r['Name'] ?? '').trim();
    if (!name) continue;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(r);
  }
  const orders = [];
  for (const [orderName, rs] of groups) {
    const f = rs[0];
    const createdAtLocal = String(f['Created at'] ?? '').trim();
    const cancelledRow = rs.find(r => String(r['Cancelled at'] ?? r['Cancelled At'] ?? '').trim());
    const refunded = moneyOrNull(f['Refunded Amount'] ?? f['Refunded amount']);
    const lines = rs.map((r, lineIndex) => {
      const lineDiscount = moneyOrNull(r['Lineitem discount']);
      return {
        lineIndex,
        lineId:          null,
        sku:             String(r['Lineitem sku'] ?? '').trim(),
        productName:     String(r['Lineitem name'] ?? ''),
        quantity:        intOrNull(r['Lineitem quantity']),
        currentQuantity: null,
        unitPrice:       moneyOrNull(r['Lineitem price']),
        vendor:          String(r['Vendor'] ?? ''),
        lineDiscount,
        discountSource:  (lineDiscount || 0) > 0 ? DISCOUNT_SOURCES.HISTORICAL_CSV_LINE_DISCOUNT : DISCOUNT_SOURCES.NONE,
        discountAllocations: [],
        requiresShipping: String(r['Lineitem requires shipping'] ?? ''),
        ...(blankToNull(r['Lineitem fulfillment status']) !== null ? { fulfillmentStatus: String(r['Lineitem fulfillment status']).trim() } : {}),
      };
    });
    orders.push({
      orderName,
      orderNumber:    orderNumberOf(orderName),
      shopifyId:      blankToNull(f['Id']),
      createdAt:      csvLocalToIso(createdAtLocal),
      createdAtLocal,
      businessDate:   businessDateOf(createdAtLocal),
      cancelledAt:    cancelledRow ? String(cancelledRow['Cancelled at'] ?? cancelledRow['Cancelled At']).trim() : null,
      ...(blankToNull(f['Fulfillment Status']) !== null ? { fulfillmentStatus: String(f['Fulfillment Status']).trim() } : {}),
      ...(blankToNull(f['Fulfilled at']) !== null ? { fulfilledAt: String(f['Fulfilled at']).trim() } : {}),
      subtotal:       moneyOrNull(f['Subtotal']),
      shipping:       moneyOrNull(f['Shipping']),
      taxes:          moneyOrNull(f['Taxes']),
      total:          moneyOrNull(f['Total']),
      duties:         moneyOrNull(f['Duties']),
      discountAmount: moneyOrNull(f['Discount Amount']),
      refundedAmount: refunded,
      discountCodes:  String(f['Discount Code'] ?? '').split(',').map(s => s.trim()).filter(Boolean),
      sourceName:     String(f['Source name'] ?? f['Source'] ?? ''),
      tags:           String(f['Tags'] ?? '').split(',').map(s => s.trim()).filter(Boolean),
      noteAttributes: parseCsvNoteAttributes(f['Note Attributes'] ?? f['Note attributes']),
      store,
      sourceSystem:   SOURCE_SYSTEMS.SHOPIFY_CSV,
      lines,
      refunds: (refunded || 0) > 0 ? [{
        refundId:     `csv:${orderName}`,
        processedAt:  null,
        amount:       refunded,
        refundSource: REFUND_SOURCES.HISTORICAL_PRORATED_REFUND,
        lines: [], shippingLines: [], adjustments: [],
      }] : [],
    });
  }
  return orders;
}

// ─── normalized → Shopify CSV rows (engine input) ─────────────────────────────

const money = v => (v === null || v === undefined) ? '' : Number(v).toFixed(2);
const int   = v => (v === null || v === undefined) ? '' : String(v);

/** Order-level columns Shopify writes on an order's first row only. */
const ORDER_LEVEL_BLANK = Object.freeze({
  'Cancelled at': '', 'Financial Status': '', 'Subtotal': '', 'Shipping': '', 'Taxes': '',
  'Total': '', 'Discount Code': '', 'Discount Amount': '', 'Refunded Amount': '',
  'Source': '', 'Note Attributes': '', 'Tags': '', 'Duties': '',
  'Fulfillment Status': '', 'Fulfilled at': '',
});

/**
 * NormalizedOrder[] → { rows, keys } where rows are exactly what parseCSV()
 * would have produced for the same orders, and keys[i] = { orderName, lineIndex }
 * identifies the normalized line behind rows[i].
 */
export function toLegacyShopifyRows(orders) {
  assertNoCustomerFields(orders);
  const rows = [], keys = [];
  for (const o of orders) {
    const lines = o.lines && o.lines.length ? [...o.lines].sort((a, b) => a.lineIndex - b.lineIndex) : [null];
    lines.forEach((li, i) => {
      const orderLevel = i === 0 ? {
        'Cancelled at':     o.cancelledAt || '',
        'Financial Status': '',
        'Subtotal':         money(o.subtotal),
        'Shipping':         money(o.shipping),
        'Taxes':            money(o.taxes),
        'Total':            money(o.total),
        'Discount Code':    (o.discountCodes || []).join(', '),
        'Discount Amount':  money(o.discountAmount),
        'Refunded Amount':  money(o.refundedAmount),
        'Source':           o.sourceName || '',
        'Note Attributes':  formatCsvNoteAttributes(o.noteAttributes),
        'Tags':             (o.tags || []).join(', '),
        'Duties':           o.duties ? money(o.duties) : '',
        'Fulfillment Status': o.fulfillmentStatus || '',
        'Fulfilled at':     o.fulfilledAt || '',
      } : ORDER_LEVEL_BLANK;
      rows.push({
        'Name':                       o.orderName,
        'Created at':                 o.createdAtLocal || '',
        ...orderLevel,
        'Lineitem quantity':          li ? int(li.quantity) : '',
        'Lineitem name':              li ? (li.productName ?? '') : '',
        'Lineitem price':             li ? money(li.unitPrice) : '',
        'Lineitem sku':               li ? (li.sku ?? '') : '',
        'Lineitem discount':          li ? money(li.lineDiscount) : '',
        'Lineitem requires shipping': li ? (li.requiresShipping === null || li.requiresShipping === undefined ? 'true' : String(li.requiresShipping)) : '',
        'Vendor':                     li ? (li.vendor ?? '') : '',
        'Lineitem fulfillment status': li ? (li.fulfillmentStatus ?? '') : '',
      });
      keys.push({ orderName: o.orderName, lineIndex: li ? li.lineIndex : null });
    });
  }
  return { rows, keys };
}

/**
 * calculate() emits one line per row that has a SKU, skipping cancelled orders.
 * Reproduce that filter so each engine line can be tied back to its normalized
 * line. Throws if the alignment ever disagrees — a silent misalignment would
 * attach one line's audit fields to another.
 */
export function attachLineKeys(engineLines, rows, keys, { excludeCancelled = true } = {}) {
  const cancelled = new Set();
  for (const r of rows) if (String(r['Cancelled at'] ?? '').trim()) cancelled.add(String(r['Name']).trim());
  // C3: a cancelled-after-shipping order yields ONE shipping-only engine line,
  // emitted at the order's first SKU row.
  const shippingOnly = new Set(engineLines.filter(l => l.isShippingOnly).map(l => l.orderNum));
  const placed = new Set();
  const kept = [];
  rows.forEach((r, i) => {
    const sku = String(r['Lineitem sku'] ?? '').trim();
    if (!sku || sku.toLowerCase() === 'nan') return;
    const name = String(r['Name']).trim();
    if (excludeCancelled && cancelled.has(name)) {
      if (shippingOnly.has(name) && !placed.has(name)) { placed.add(name); kept.push({ ...keys[i], sku: '' }); }
      return;
    }
    kept.push({ ...keys[i], sku });
  });
  if (kept.length !== engineLines.length) {
    throw new Error(`Line alignment failed: ${kept.length} eligible rows, ${engineLines.length} engine lines`);
  }
  return engineLines.map((li, i) => {
    const k = kept[i];
    if (k.orderName !== li.orderNum || k.sku !== li.sku) {
      throw new Error(`Line alignment failed at ${i}: ${k.orderName}/${k.sku} vs ${li.orderNum}/${li.sku}`);
    }
    return { ...li, lineIndex: k.lineIndex };
  });
}

// ─── ShipStation → engine cost map ────────────────────────────────────────────

/**
 * NormalizedShipment[] → Map<orderNumber, expense>, the shape calculate() takes
 * as `shipStationCosts`. Only shipments with a selected, positive expense are
 * summed; an order with none is left out, which the engine already treats as
 * "no ShipStation rate". `Shipping Paid` is never an expense here.
 */
export function toLegacyShipStationCosts(shipments, policy = DEFAULT_EXPENSE_POLICY) {
  const costs = new Map();
  for (const s of shipments) {
    const e = selectShipmentExpense(s, policy);
    if (!(e.amount > 0)) continue;
    const k = normalizeOrderNumber(s.orderNumber);
    // Summed without rounding, exactly as parseShipStation() does, so the
    // automated and manual paths hand the engine bit-identical inputs.
    costs.set(k, (costs.get(k) || 0) + e.amount);
  }
  return costs;
}

// ─── HPD → engine map ─────────────────────────────────────────────────────────

/** NormalizedHpdOrder[] → the Map parseHpdLog() returns, keyed by Shopify order number. */
export function toLegacyHpdMap(hpdOrders) {
  const m = new Map();
  for (const h of hpdOrders || []) {
    m.set(String(h.shopifyOrderNumber), {
      hpdOrderNum:     h.hpdOrderNumber,
      shopifyOrderNum: String(h.shopifyOrderNumber),
      date:            h.orderDate || '',
      carrier:         h.carrierService || '',
      state:           '',                       // not stored: not used by any calculation
      netTerms:        h.netTerms ?? null,
      prepaid:         h.prepaid ?? null,
      costDiff:        h.costDifference ?? null,
      items:           (h.items || []).map(i => ({ sku: i.sku, qty: i.qty })),
    });
  }
  return m;
}
