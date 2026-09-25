/**
 * shopifyCsv.js — the Shopify orders-export column allowlist
 * ===========================================================
 * Shopify's admin orders export always carries customer columns (email, billing
 * and shipping name/address/phone, notes). The Windows collector keeps ONLY the
 * columns below, in memory, before anything leaves the machine
 * (sanitizeShopifyOrderRows). The Worker then refuses any upload that still
 * carries another column or a note attribute outside the engine's allowlist
 * (assertSanitizedShopifyOrderRows): customer data is rejected, never dropped
 * silently on the server.
 *
 * The allowlist is exactly what the manual-upload path reads
 * (csvRowsToNormalizedOrders), plus Currency for the store-currency cross-check.
 * Both spellings Shopify has used for a column are allowed.
 */
import { CustomerDataError, isKeptNoteAttribute, formatCsvNoteAttributes } from '../normalized.js';

export const SHOPIFY_ORDERS_CSV_COLUMNS = Object.freeze([
  'Name', 'Id', 'Created at', 'Cancelled at', 'Cancelled At', 'Financial Status', 'Currency',
  'Subtotal', 'Shipping', 'Taxes', 'Total', 'Duties', 'Discount Code', 'Discount Amount',
  'Refunded Amount', 'Refunded amount', 'Source', 'Source name', 'Tags', 'Note Attributes', 'Note attributes',
  'Vendor', 'Lineitem name', 'Lineitem price', 'Lineitem quantity', 'Lineitem sku', 'Lineitem discount',
  'Lineitem requires shipping',
]);
const ALLOWED = new Set(SHOPIFY_ORDERS_CSV_COLUMNS);

/** Columns an orders upload cannot be interpreted without. */
export const SHOPIFY_ORDERS_CSV_REQUIRED = Object.freeze([
  'Name', 'Created at', 'Subtotal', 'Total', 'Lineitem name', 'Lineitem price', 'Lineitem quantity', 'Lineitem sku',
]);

const NOTE_COLUMNS = ['Note Attributes', 'Note attributes'];

/** "key: value" lines → [{ key, value }] WITHOUT filtering (the check below needs every key). */
function rawNoteAttributes(text) {
  return String(text ?? '').split(/\r?\n/)
    .map(l => { const i = l.indexOf(':'); return i < 0 ? (l.trim() ? { key: l.trim(), value: '' } : null) : { key: l.slice(0, i).trim(), value: l.slice(i + 1).trim() }; })
    .filter(Boolean);
}

/**
 * Windows side: keep only allowlisted columns, and only the engine's note
 * attributes. Returns the sanitized rows and the NAMES of dropped columns
 * (never their values).
 */
export function sanitizeShopifyOrderRows(rows) {
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const kept = headers.filter(h => ALLOWED.has(h));
  const dropped = headers.filter(h => !ALLOWED.has(h));
  const out = rows.map(r => {
    const o = {};
    for (const h of kept) o[h] = r[h] ?? '';
    for (const nc of NOTE_COLUMNS) {
      if (nc in o) o[nc] = formatCsvNoteAttributes(rawNoteAttributes(o[nc]).filter(a => isKeptNoteAttribute(a.key)));
    }
    return o;
  });
  return { rows: out, columns: kept, droppedColumns: dropped };
}

/**
 * Worker side: an upload must already be sanitized. Any non-allowlisted column,
 * or a note attribute outside the allowlist, rejects the whole upload.
 */
export function assertSanitizedShopifyOrderRows(rows) {
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const extra = headers.filter(h => !ALLOWED.has(h));
  const paths = extra.map(h => `$.columns.${h}`);
  rows.forEach((r, i) => {
    for (const nc of NOTE_COLUMNS) {
      for (const a of rawNoteAttributes(r[nc])) if (!isKeptNoteAttribute(a.key)) paths.push(`$[${i}].${nc}.${a.key}`);
    }
  });
  if (paths.length) throw new CustomerDataError(paths);
  const missing = SHOPIFY_ORDERS_CSV_REQUIRED.filter(h => !headers.includes(h));
  if (rows.length && missing.length) {
    const e = new Error(`Shopify orders CSV is missing required columns: ${missing.join(', ')}`);
    e.code = 'bad_payload';
    throw e;
  }
}

/** Currencies present in the upload (for the store-currency cross-check). */
export function currenciesOf(rows) {
  return [...new Set(rows.map(r => String(r['Currency'] ?? '').trim()).filter(Boolean))];
}

/** RFC 4180 CSV text for sanitized rows (the Windows collector's upload body). */
export function toCsvText(rows, columns) {
  const q = v => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [columns.map(q).join(','), ...rows.map(r => columns.map(c => q(r[c])).join(','))].join('\n') + '\n';
}
