/**
 * corporateOrders.js — the corporate-gifting Shopify order payload ("sbcg-orders-v1")
 * ===================================================================================
 * Dependency-free ES module. Used by:
 *   - this app's manual "Upload Shopify report" (runs in the browser, so the raw export never
 *     leaves the team member's computer), and
 *   - the existing GP Windows collector, as a proposed small addition (see docs/COLLECTOR_CONTRACT.md):
 *     the collector already holds the raw orders export in memory; it would call
 *     prepareCorporateOrdersPayload() on the same rows and POST the result to this app.
 *
 * Kept per order: identifiers, dates, financial status, currency, order-level money columns,
 * line items (SKU, title, quantity, price, line discount) and three classification fields
 * (Source, Tags, Billing Company). Everything else in the export — customer names, emails, phones,
 * addresses, notes, note attributes, discount codes, payment references — is never read.
 * Tags / company values that look like personal data (email, URL, phone) are dropped.
 */

export const PAYLOAD_FORMAT = "sbcg-orders-v1";
export const CLASSIFICATION_FIELDS = ["source", "tags", "billing_company"];

/** Shopify orders-export columns this payload reads (both historical spellings accepted). */
export const READ_COLUMNS = Object.freeze([
  "Name", "Id", "Created at", "Cancelled at", "Cancelled At", "Financial Status", "Currency",
  "Subtotal", "Shipping", "Taxes", "Duties", "Total", "Discount Amount", "Refunded Amount", "Refunded amount",
  "Source", "Source name", "Tags", "Billing Company",
  "Lineitem name", "Lineitem price", "Lineitem quantity", "Lineitem sku", "Lineitem discount",
]);
export const REQUIRED_COLUMNS = Object.freeze(["Name", "Created at", "Subtotal", "Total", "Lineitem name", "Lineitem price", "Lineitem quantity"]);

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const URL_RE = /https?:\/\/|www\./i;
const PHONE = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/;
/** Same patterns as the GP collector's looksPersonal(). */
export const looksPersonal = (s) => EMAIL.test(s) || URL_RE.test(s) || PHONE.test(s);

/** RFC 4180 CSV → array of objects keyed by header. */
export function parseCsvObjects(text) {
  const src = String(text ?? "").replace(/^﻿/, "");
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const headers = (rows.shift() || []).map((h) => h.trim());
  return { headers, rows: rows.filter((r) => r.some((v) => v !== "")).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""]))) };
}

const str = (v) => { const s = String(v ?? "").trim(); return s === "" ? null : s; };
const first = (rows, ...cols) => { for (const r of rows) for (const c of cols) { const v = str(r[c]); if (v !== null) return v; } return null; };

/**
 * Raw Shopify orders-export rows (one row per line item; order-level columns are filled on the
 * order's first row) → reduced orders. Returns { orders, problems, missingColumns, fields }.
 */
export function reduceShopifyOrderRows(rows, headers) {
  const hdrs = headers || (rows.length ? Object.keys(rows[0]) : []);
  const missingColumns = REQUIRED_COLUMNS.filter((h) => !hdrs.includes(h));
  if (!hdrs.includes("Refunded Amount") && !hdrs.includes("Refunded amount")) missingColumns.push("Refunded Amount");
  const fields = [];
  if (hdrs.includes("Source") || hdrs.includes("Source name")) fields.push("source");
  if (hdrs.includes("Tags")) fields.push("tags");
  if (hdrs.includes("Billing Company")) fields.push("billing_company");
  if (missingColumns.length) return { orders: [], problems: [], missingColumns, fields };

  const byName = new Map();
  for (const r of rows) {
    const name = str(r["Name"]);
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(r);
  }
  const problems = [];
  const orders = [];
  for (const [name, rs] of byName) {
    const tagsRaw = first(rs, "Tags");
    const tags = tagsRaw === null ? (fields.includes("tags") ? [] : null)
      : tagsRaw.split(",").map((t) => t.trim()).filter((t) => t && !looksPersonal(t));
    let company = first(rs, "Billing Company");
    if (company && looksPersonal(company)) company = null;
    const lines = rs.map((r) => ({
      sku: str(r["Lineitem sku"]),
      name: str(r["Lineitem name"]),
      quantity: Number.parseInt(String(r["Lineitem quantity"] ?? "").trim(), 10),
      price: str(r["Lineitem price"]),
      discount: str(r["Lineitem discount"]),
    })).filter((l) => l.name !== null || l.sku !== null);
    for (const l of lines) {
      if (l.name && looksPersonal(l.name)) { problems.push({ order: orders.length, field: "lines.name", rule: "looks like personal data" }); l.name = "[removed]"; }
      if (!Number.isFinite(l.quantity)) l.quantity = null;
    }
    orders.push({
      id: first(rs, "Id"),
      name,
      createdAt: first(rs, "Created at"),
      cancelledAt: first(rs, "Cancelled at", "Cancelled At"),
      financialStatus: first(rs, "Financial Status"),
      currency: first(rs, "Currency"),
      subtotal: first(rs, "Subtotal"),
      shipping: first(rs, "Shipping"),
      taxes: first(rs, "Taxes"),
      duties: first(rs, "Duties"),
      total: first(rs, "Total"),
      discountAmount: first(rs, "Discount Amount"),
      refundedAmount: first(rs, "Refunded Amount", "Refunded amount"),
      source: fields.includes("source") ? (first(rs, "Source", "Source name") ?? "") : null,
      tags: fields.includes("tags") ? tags : null,
      billingCompany: fields.includes("billing_company") ? company : null,
      lines,
    });
  }
  return { orders, problems, missingColumns, fields };
}

/** Business date (YYYY-MM-DD) of a Shopify "Created at" in America/Los_Angeles. */
export function laDateOf(createdAt) {
  const s = String(createdAt ?? "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (!m) return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  if (!m[7]) return `${m[1]}-${m[2]}-${m[3]}`; // no offset: already the store's local time
  const off = m[7] === "Z" ? "Z" : m[7].replace(/^([+-]\d{2}):?(\d{2})$/, "$1:$2");
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}${off}`);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/**
 * Build the upload payload. `exportedAt` = when the report was generated/downloaded (ISO);
 * `coverageFrom/To` = the export's order-date filter (YYYY-MM-DD, America/Los_Angeles).
 */
export function prepareCorporateOrdersPayload(rows, { headers, exportedAt, coverageFrom, coverageTo, store = "succulentsbox", fileName = null }) {
  const r = reduceShopifyOrderRows(rows, headers);
  if (r.missingColumns.length) return { refused: "missing_columns", missingColumns: r.missingColumns };
  return {
    payload: { format: PAYLOAD_FORMAT, store, exportedAt, coverageFrom, coverageTo, fileName, fields: r.fields, orders: r.orders },
    problems: r.problems,
    facts: { orderCount: r.orders.length, rowCount: rows.length, fields: r.fields },
  };
}
