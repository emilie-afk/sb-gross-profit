/**
 * shippingCostReport.js — ShipStation Analytics → Reports → Shipping Cost Report
 * =============================================================================
 * Source role `shipstation_shipping_cost_report`: the proposed carrier-expense
 * source (Revision 9). Field contract verified on the real Aug 1–Sep 21 and
 * Jul 1–Sep 24 exports (headers, formats, multi-row orders, zero-paid rows).
 * Still unverified: voided / refunded / recreated / return labels and later
 * carrier adjustments — shipping_cost_report_source_verified stays false.
 *
 * Raw export: 18 columns. Three are dropped on the collector before upload:
 *   Recipient      customer PII
 *   Shipping Paid  repeats on every row of a multi-row order; Shopify owns revenue
 *   +/-            = Shipping Paid − Shipping Cost; misleading on multi-row orders
 * The sanitized upload has exactly the 15 SHIPPING_COST_REPORT_COLUMNS, in any
 * order. Shipping Cost is the only financial field; the rest are diagnostic.
 *
 * Money is handled in integer cents. Ship Date is a calendar date (M/D/YYYY,
 * always "12:00:00 AM") in the configured report time zone; the original
 * string is kept unchanged next to the parsed date.
 */

export const SHIPPING_COST_REPORT_RAW_COLUMNS = Object.freeze([
  'Ship Date', 'Recipient', 'Order #', 'Provider', 'Service', 'Package', 'Items', 'Zone', 'Shipping Paid',
  'Shipping Cost', 'Insurance Cost', 'Weight', 'Weight Unit', 'Store', 'Duties', 'Taxes', 'Import Fee', '+/-',
]);
export const SHIPPING_COST_REPORT_DROPPED = Object.freeze(['Recipient', 'Shipping Paid', '+/-']);
export const SHIPPING_COST_REPORT_COLUMNS = Object.freeze([
  'Ship Date', 'Order #', 'Provider', 'Service', 'Package', 'Items', 'Zone', 'Shipping Cost', 'Insurance Cost',
  'Weight', 'Weight Unit', 'Store', 'Duties', 'Taxes', 'Import Fee',
]);
/** Excluded from expense; a non-zero value puts the import under review. */
export const REVIEW_MONEY_COLUMNS = Object.freeze(['Insurance Cost', 'Duties', 'Taxes', 'Import Fee']);
export const SCHEMA_VERSION = 'shipping_cost_report.v1';

const DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: (\d{1,2}):(\d{2}):(\d{2}) ([AP]M))?$/;
const MONEY_RE = /^-?\d+(\.\d{1,2})?$/;
const ORDER_RE = /^\d{4,10}$/;

/** "8/10/2026 12:00:00 AM" → { date: '2026-08-10', midnight: true } or null. */
export function parseShipDate(s) {
  const m = String(s ?? '').trim().match(DATE_RE);
  if (!m) return null;
  const [, mo, d, y, hh, mm, ss, ap] = m;
  const mon = +mo, day = +d;
  if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
  const date = `${y}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const back = new Date(`${date}T00:00:00Z`);
  if (isNaN(back) || back.toISOString().slice(0, 10) !== date) return null;
  const midnight = hh === undefined || (hh === '12' && mm === '00' && ss === '00' && ap === 'AM');
  return { date, midnight };
}

/** Exact decimal string → integer cents (no floating point). */
export function toCents(s) {
  const t = String(s ?? '').trim();
  if (!MONEY_RE.test(t)) return null;
  const neg = t.startsWith('-');
  const [w, f = ''] = t.replace('-', '').split('.');
  const c = Number(w) * 100 + Number((f + '00').slice(0, 2));
  return neg ? -c : c;
}
export const fromCents = c => (c === null || c === undefined ? null : Math.round(c) / 100);

/** ShipStation "475860" and Shopify "#475860" → the same key. */
export function canonicalOrderKey(v) {
  const s = String(v ?? '').trim().replace(/^#/, '');
  return /^\d+$/.test(s) ? s : s.toUpperCase();
}

/**
 * Collector / browser side: raw report rows → the 15 approved columns.
 * The raw header set must be exactly the verified 18 columns; anything else
 * means ShipStation changed the report and the file is refused.
 */
export function sanitizeShippingCostReport(rawRows) {
  const headers = rawRows.length ? Object.keys(rawRows[0]).map(h => h.replace(/^\uFEFF/, '')) : [];
  const unknown = headers.filter(h => !SHIPPING_COST_REPORT_RAW_COLUMNS.includes(h));
  const missing = SHIPPING_COST_REPORT_RAW_COLUMNS.filter(h => !headers.includes(h));
  if (unknown.length || missing.length) {
    const e = new Error(`Shipping Cost Report columns changed (unknown: ${unknown.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'})`);
    e.code = 'report_schema_changed';
    throw e;
  }
  const rows = rawRows.map(r => {
    const clean = {};
    for (const [k, v] of Object.entries(r)) clean[k.replace(/^\uFEFF/, '')] = v;
    const o = {};
    for (const c of SHIPPING_COST_REPORT_COLUMNS) o[c] = clean[c] ?? '';
    return o;
  });
  return { rows, columns: [...SHIPPING_COST_REPORT_COLUMNS], dropped: [...SHIPPING_COST_REPORT_DROPPED] };
}

/**
 * Validate sanitized rows and parse them. Throws (code report_invalid) on
 * anything that makes the file unusable; returns review flags for conditions
 * that keep a version out of `accepted` until an admin decides.
 *
 * @param {object[]} rows      sanitized rows (exactly the 15 columns)
 * @param {object}   opts      { requestedFrom, requestedTo (YYYY-MM-DD), expectedStore }
 */
export function parseShippingCostReport(rows, { requestedFrom, requestedTo, expectedStore = null } = {}) {
  const fail = msg => { const e = new Error(msg); e.code = 'report_invalid'; throw e; };
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const extra = headers.filter(h => !SHIPPING_COST_REPORT_COLUMNS.includes(h));
  const missing = SHIPPING_COST_REPORT_COLUMNS.filter(h => !headers.includes(h));
  if (extra.length) { const e = new Error(`Unapproved columns: ${extra.join(', ')}`); e.code = 'unapproved_columns'; e.columns = extra; throw e; }
  if (missing.length) fail(`Missing columns: ${missing.join(', ')}`);
  if (!rows.length) fail('The report has no rows');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedFrom || '') || !/^\d{4}-\d{2}-\d{2}$/.test(requestedTo || '') || requestedFrom > requestedTo)
    fail('requestedFrom / requestedTo must be YYYY-MM-DD with from ≤ to');

  const flags = new Map();
  const flag = (code, n = 1) => flags.set(code, (flags.get(code) || 0) + n);
  const parsed = rows.map((r, i) => {
    const d = parseShipDate(r['Ship Date']);
    if (!d) fail(`Row ${i + 1}: Ship Date is not M/D/YYYY`);
    if (!d.midnight) flag('ship_date_time_not_midnight');
    if (d.date < requestedFrom || d.date > requestedTo) fail(`Row ${i + 1}: Ship Date outside the requested period`);
    const order = String(r['Order #'] ?? '').trim();
    if (!ORDER_RE.test(order)) fail(`Row ${i + 1}: Order # is not a Shopify order number`);
    const cost = toCents(r['Shipping Cost']);
    if (cost === null) fail(`Row ${i + 1}: Shipping Cost is not a decimal amount`);
    if (cost < 0) fail(`Row ${i + 1}: Shipping Cost is negative`);
    if (cost === 0) flag('zero_shipping_cost');
    const other = {};
    for (const c of REVIEW_MONEY_COLUMNS) {
      const v = String(r[c] ?? '').trim() === '' ? 0 : toCents(r[c]);
      if (v === null) fail(`Row ${i + 1}: ${c} is not a decimal amount`);
      if (v !== 0) flag(`nonzero_${c.toLowerCase().replace(/ /g, '_')}`);
      other[c] = v;
    }
    if (expectedStore && String(r['Store']).trim() !== expectedStore) flag('unexpected_store');
    return {
      rowSeq: i, shipDateRaw: String(r['Ship Date']), shipDate: d.date, orderKey: canonicalOrderKey(order),
      provider: String(r['Provider'] ?? ''), service: String(r['Service'] ?? ''), package: String(r['Package'] ?? ''),
      items: String(r['Items'] ?? ''), zone: String(r['Zone'] ?? ''), shippingCostCents: cost,
      insuranceCents: other['Insurance Cost'], dutiesCents: other['Duties'], taxesCents: other['Taxes'], importFeeCents: other['Import Fee'],
      weight: String(r['Weight'] ?? ''), weightUnit: String(r['Weight Unit'] ?? ''), store: String(r['Store'] ?? ''),
    };
  });
  return {
    rows: parsed,
    rowCount: parsed.length,
    shippingCostCents: parsed.reduce((s, r) => s + r.shippingCostCents, 0),
    firstShipDate: parsed.reduce((m, r) => (r.shipDate < m ? r.shipDate : m), parsed[0].shipDate),
    lastShipDate: parsed.reduce((m, r) => (r.shipDate > m ? r.shipDate : m), parsed[0].shipDate),
    reviewFlags: Object.fromEntries(flags),
  };
}

/** Rows → per-order aggregate. Rows are never collapsed: identical rows are separate packages. */
export function aggregateByOrder(rows) {
  const m = new Map();
  for (const r of rows) {
    const a = m.get(r.orderKey) || { orderKey: r.orderKey, costCents: 0, rowCount: 0, firstShipDate: r.shipDate, lastShipDate: r.shipDate };
    a.costCents += r.shippingCostCents; a.rowCount += 1;
    if (r.shipDate < a.firstShipDate) a.firstShipDate = r.shipDate;
    if (r.shipDate > a.lastShipDate) a.lastShipDate = r.shipDate;
    m.set(r.orderKey, a);
  }
  return m;
}

/** Collector upload body for a sanitized report. */
export function shippingCostUploadBody({ text, requestedFrom, requestedTo, rowCount, shippingCostTotal, sanitizedSha256, exportedAt }) {
  return { format: 'csv_text', text, requestedFrom, requestedTo, rowCount, shippingCostTotal, sanitizedSha256, exportedAt };
}
