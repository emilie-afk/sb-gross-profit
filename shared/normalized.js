/**
 * normalized.js — the normalized source model shared by every ingestion path
 * ==========================================================================
 * Shopify GraphQL, Shopify CSV backfill, ShipStation exports and the HPD log all
 * normalize into these shapes before anything is stored or calculated. The
 * legacy calculator never sees these objects directly; shared/adapters/legacy.js
 * turns them back into the exact row shape the engine has always consumed.
 *
 * Data minimization is enforced here, not downstream:
 *   - no customer name, email, phone, address, company or buyer note is copied
 *   - Shopify note attributes are reduced to the keys the engine inspects
 *   - inputs that carry customer fields are rejected, because it means the
 *     upstream query or export template is selecting fields it must not
 *
 * NormalizedOrder
 *   { orderName, orderNumber, shopifyId, createdAt, createdAtLocal, businessDate,
 *     cancelledAt, subtotal, shipping, taxes, total, duties, discountAmount,
 *     refundedAmount, discountCodes[], sourceName, tags[], noteAttributes[{key,value}],
 *     store, sourceSystem, lines[NormalizedLine], refunds[NormalizedRefund] }
 *
 * NormalizedLine
 *   { lineIndex, lineId, sku, productName, quantity, currentQuantity, unitPrice,
 *     vendor, lineDiscount, discountSource, discountAllocations[] }
 *
 * NormalizedRefund
 *   { refundId, processedAt, amount, refundSource,
 *     lines[{ lineId, lineIndex, quantity, subtotal, tax }],
 *     shippingLines[{ subtotal, tax }], adjustments[{ amount, tax, reason }] }
 *
 * NormalizedShipment — see shared/adapters/shipstation.js
 * NormalizedHpdOrder — see shared/adapters/hpd.js
 */

export const SOURCE_SYSTEMS = Object.freeze({
  SHOPIFY_GRAPHQL: 'shopify_graphql',
  SHOPIFY_CSV:     'shopify_csv',
});

export const DISCOUNT_SOURCES = Object.freeze({
  SHOPIFY_LINE_ALLOCATION:        'shopify_line_allocation',
  HISTORICAL_CSV_LINE_DISCOUNT:   'historical_csv_line_discount',
  HISTORICAL_RESIDUAL_ALLOCATION: 'historical_residual_allocation',
  NONE:                           'none',
});

export const REFUND_SOURCES = Object.freeze({
  SHOPIFY_REFUND_LINE:       'shopify_refund_line',
  HISTORICAL_PRORATED_REFUND: 'historical_prorated_refund',
  NONE:                      'none',
});

/** Rounds exactly the way the engine does, so sums reconcile to the cent. */
export const r2 = x => Math.round((Number(x) || 0) * 100) / 100;

/** '$1,234.50' | '1234.5' | 1234.5 | { shopMoney: { amount } } | { amount } → number | null */
export function toMoney(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'object') {
    if (v.shopMoney) return toMoney(v.shopMoney.amount);
    if ('amount' in v) return toMoney(v.amount);
    return null;
  }
  const s = String(v).trim().replace(/[$,]/g, '');
  if (s === '') return null;
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

export const moneyOrZero = v => toMoney(v) ?? 0;

/** '#100001' | '100001' | 100001 → '100001'. Mirrors calculator.normalizeOrderNumber for digits. */
export function orderNumberOf(orderName) {
  return String(orderName ?? '').trim().replace(/^#/, '');
}

// ─── Customer-data guard ──────────────────────────────────────────────────────

/**
 * Object keys that identify a customer. A GraphQL response or export row that
 * carries any of them was produced by a query or template that selects fields
 * this pipeline must never receive.
 *
 * Deliberately NOT listed: `name` (an order's "#100001" and a line's product
 * title) and `title` — both are needed and are not customer data.
 */
export const CUSTOMER_KEYS = new Set([
  'customer', 'email', 'contactemail', 'phone', 'shippingaddress', 'billingaddress',
  'displayaddress', 'firstname', 'lastname', 'address1', 'address2', 'city', 'zip',
  'province', 'provincecode', 'company', 'note', 'customernote', 'buyeracceptsmarketing',
  'clientip', 'browserip', 'customerlocale', 'recipient', 'shipto',
]);

export class CustomerDataError extends Error {
  constructor(paths) {
    super(`Input contains customer fields and was rejected: ${paths.slice(0, 5).join(', ')}` +
          (paths.length > 5 ? ` (+${paths.length - 5} more)` : ''));
    this.name = 'CustomerDataError';
    this.paths = paths;
  }
}

/** Every path whose key is a customer key. Walks objects and arrays. */
export function findCustomerFields(value, path = '$', out = []) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => findCustomerFields(v, `${path}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const key = k.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (CUSTOMER_KEYS.has(key) && v !== null && v !== undefined && v !== '') out.push(`${path}.${k}`);
      else findCustomerFields(v, `${path}.${k}`, out);
    }
  }
  return out;
}

export function assertNoCustomerFields(value) {
  const paths = findCustomerFields(value);
  if (paths.length) throw new CustomerDataError(paths);
}

// ─── Note attributes ──────────────────────────────────────────────────────────

/**
 * The engine reads two things from Shopify note attributes:
 *   "Channel: amazon"            → the order's sales channel (Sellbrite imports)
 *   "Free sample: $28.86"        → influencer / sample detection
 * Only those keys are kept. Everything else (gift messages, delivery notes,
 * anything free text) is dropped before it is stored.
 */
export function isKeptNoteAttribute(key) {
  const k = String(key ?? '').trim();
  return /^channel$/i.test(k) || /sample/i.test(k);
}

export function filterNoteAttributes(attrs) {
  return (attrs || [])
    .map(a => ({ key: String(a.key ?? a.name ?? '').trim(), value: String(a.value ?? '').trim() }))
    .filter(a => a.key && isKeptNoteAttribute(a.key));
}

/** Shopify CSV writes note attributes as "key: value" lines. */
export function parseCsvNoteAttributes(text) {
  return filterNoteAttributes(String(text ?? '')
    .split(/\r?\n/)
    .map(l => { const i = l.indexOf(':'); return i < 0 ? null : { key: l.slice(0, i), value: l.slice(i + 1) }; })
    .filter(Boolean));
}

export function formatCsvNoteAttributes(attrs) {
  return (attrs || []).map(a => `${a.key}: ${a.value}`).join('\n');
}

// ─── Dates ────────────────────────────────────────────────────────────────────

export const DEFAULT_STORE_TIMEZONE = 'America/Los_Angeles';

/**
 * ISO instant → Shopify-CSV style local timestamp "2026-09-15 10:04:12 -0700".
 * The engine buckets by `Created at`.slice(0, 10), so a UTC date would move
 * evening orders onto the next day. Converting to the store's zone keeps the
 * automated path on the same business date as the CSV path.
 */
export function toStoreLocal(iso, timeZone = DEFAULT_STORE_TIMEZONE) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map(p => [p.type, p.value]));
  const localAsUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offsetMin = Math.round((localAsUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000);
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  const off = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${off}`;
}

/** "2026-09-15 10:04:12 -0700" | "2026-09-15" → "2026-09-15" */
export function businessDateOf(localTimestamp) {
  const m = String(localTimestamp ?? '').match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/** Monday of the Monday–Sunday week containing a YYYY-MM-DD date. */
export function weekStartOf(date) {
  const m = String(date ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const dow = d.getUTCDay();                 // 0 = Sunday
  d.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export function addDays(date, n) {
  const m = String(date).match(/^(\d{4})-(\d{2})-(\d{2})/);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ─── Hashing ──────────────────────────────────────────────────────────────────

/** Stable JSON: object keys sorted, so a content hash does not depend on key order. */
export function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** SHA-256 hex of the stable JSON form. Works in Workers, browsers and Node 20+. */
export async function contentHash(v) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableStringify(v)));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
