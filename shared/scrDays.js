/**
 * scrDays.js — Shipping Cost Report at ship-date level (Free-tier path)
 * ====================================================================
 * The collector parses the sanitized report with the unchanged parser and
 * groups it per (ship date, order). The Worker stores one row per ship date and
 * gives every date exactly one owning version, so a week's expense is read from
 * whole dates, exactly like the active-segment lookup (proven equal).
 *
 * Also here: the Worker's segment validator (a structural pass over ≤ 100 rows,
 * cheap enough for a Free-plan request) and the date-level acceptance rules
 * (owner decisions 2026-09-29):
 *   - review, nothing activated: first version ever; a gap in coverage; a
 *     possibly incomplete trailing date; any row whose actual Shipping Cost is
 *     $0.00 or above the review cap (setting shipping_cost_review_cap_cents,
 *     default $100; a held value is kept, never discarded); a non-zero Insurance
 *     Cost, Duties, Taxes or Import Fee (until their treatment is established);
 *     a ship-date time other than midnight; an unexpected store.
 *     (Customer-paid shipping is not in the sanitized report at all: Shipping
 *     Paid is dropped on the collector, so $0 paid on prepaid subscriptions can
 *     never trigger the $0 rule.)
 *   - per date: unowned → `new` (activated); same content → `identical`
 *     (no-op); the owner's groups all unchanged plus groups only for orders
 *     that had NO accepted cost anywhere → `fill_in` (activated; the affected
 *     weeks get an unpublished draft revision); any change or removal of an
 *     accepted cost → `held` for review (not activated).
 * Money is integer cents throughout. Pure; no I/O.
 */
import { stableStringify, addDays } from './normalized.js';
import { parseShipDate, toCents, SHIPPING_COST_REPORT_COLUMNS, REVIEW_MONEY_COLUMNS } from './adapters/shippingCostReport.js';
import { looksPersonal } from './adapters/shopifyPrivacy.js';

export const SCR_SEGMENT_ROWS = 100;
export const DEFAULT_REVIEW_CAP_CENTS = 10_000;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const ORDER_RE = /^\d{4,10}$/;

/** Parser rows → Map(date → groups [[orderKey, costCents, rowCount]] sorted by orderKey). */
export function dayGroups(rows) {
  const byDate = new Map();
  for (const r of rows) {
    const m = byDate.get(r.shipDate) || byDate.set(r.shipDate, new Map()).get(r.shipDate);
    const g = m.get(r.orderKey) || m.set(r.orderKey, [r.orderKey, 0, 0]).get(r.orderKey);
    g[1] += r.shippingCostCents; g[2] += 1;
  }
  return new Map([...byDate.entries()].sort((a, b) => cmp(a[0], b[0]))
    .map(([d, m]) => [d, [...m.values()].sort((x, y) => cmp(x[0], y[0]))]));
}

/** SHA-256 hex (WebCrypto: Workers, browsers, Node 20+). */
export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
/**
 * Canonical form of one date: `{"date":…,"groups":[[key,cents,rows],…]}`. Groups hold only strings
 * and integers, and the keys are already in sorted order, so native JSON gives exactly the
 * key-sorted form (stableStringify) at a fraction of the CPU; the hash is unchanged.
 */
export const dayCanonical = (date, groups) => JSON.stringify({ date, groups });
export const dayHash = (date, groups) => sha256Hex(dayCanonical(date, groups));

/** Every date of [from, to] with its groups (dates without rows get []), plus hash and sums. */
export async function versionDays(rows, from, to) {
  const g = dayGroups(rows), out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const groups = g.get(d) || [];
    out.push({ date: d, groups, hash: await dayHash(d, groups), costCents: groups.reduce((s, x) => s + x[1], 0), rowCount: groups.reduce((s, x) => s + x[2], 0) });
  }
  return out;
}

/** Owned days → the effective per-order totals (≡ effectiveOrderTotals; key order). */
export function effectiveFromDays(days) {
  const m = new Map();
  for (const { date, groups } of days) for (const [k, cents, n] of groups) {
    const x = m.get(k) || m.set(k, { orderKey: k, costCents: 0, rowCount: 0, firstShipDate: date, lastShipDate: date }).get(k);
    x.costCents += cents; x.rowCount += n;
    if (date < x.firstShipDate) x.firstShipDate = date;
    if (date > x.lastShipDate) x.lastShipDate = date;
  }
  return new Map([...m.entries()].sort((a, b) => cmp(a[0], b[0])));
}

/**
 * ≡ compute.js reportForWeek(). `knownReportKeys`: the report order keys shipped
 * in the week that ARE stored Shopify orders (the Worker pins this list).
 */
export function reportFromDays({ effective, weekStart, orders, knownReportKeys, previousShippingExpense = null }) {
  const keys = new Set(orders.map(o => String(o.orderNumber || '').replace(/^#/, '')));
  const byOrder = new Map([...effective].filter(([k]) => keys.has(k)));
  const weekEnd = addDays(weekStart, 6);
  const known = new Set(knownReportKeys || []);
  const shippedInWeek = [...effective.values()].filter(a => a.firstShipDate >= weekStart && a.firstShipDate <= weekEnd && !keys.has(a.orderKey)).map(a => a.orderKey);
  const unmatchedKeys = shippedInWeek.filter(k => !known.has(k));
  return { byOrder, unmatched: { orders: unmatchedKeys.length, costCents: unmatchedKeys.reduce((s, k) => s + (effective.get(k)?.costCents || 0), 0) },
           previousShippingExpense };
}

/** Report order keys on the week's dates (the candidates for the unmatched check). */
export const weekDateKeys = (days, weekStart) => {
  const end = addDays(weekStart, 6), s = new Set();
  for (const { date, groups } of days) if (date >= weekStart && date <= end) for (const g of groups) s.add(g[0]);
  return [...s].sort(cmp);
};

// ─── Worker segment validation (structural; ≤ 100 rows) ───────────────────────

const TEXT_MAX = 80;
const FLAG_OF = Object.fromEntries(REVIEW_MONEY_COLUMNS.map(c => [c, `nonzero_${c.toLowerCase().replace(/ /g, '_')}`]));

/**
 * Validate one sanitized segment (rows from parseCSV). Throws { code } on a
 * structural failure; returns facts only: row count, per-date cents/rows,
 * review-flag counts. Never returns or logs a value.
 */
export function validateScrSegment(rows, { expectedStore, capCents = DEFAULT_REVIEW_CAP_CENTS, from, to }) {
  const bad = code => { const e = new Error(code); e.code = code; throw e; };
  if (!rows.length) bad('segment_empty');
  if (rows.length > SCR_SEGMENT_ROWS) bad('segment_too_many_rows');
  const cols = Object.keys(rows[0]);
  if (cols.length !== SHIPPING_COST_REPORT_COLUMNS.length || cols.some((c, i) => c !== SHIPPING_COST_REPORT_COLUMNS[i])) bad('unapproved_columns');
  const perDate = {}, flags = {};
  const flag = c => { flags[c] = (flags[c] || 0) + 1; };
  for (const r of rows) {
    const d = parseShipDate(r['Ship Date']);
    if (!d) bad('ship_date_invalid');
    if (d.date < from || d.date > to) bad('ship_date_outside_period');
    if (!d.midnight) flag('ship_date_time_not_midnight');
    const order = String(r['Order #'] ?? '').trim();
    if (!ORDER_RE.test(order)) bad('order_number_invalid');
    const cost = toCents(r['Shipping Cost']);
    if (cost === null) bad('shipping_cost_invalid');
    if (cost < 0) bad('shipping_cost_negative');
    if (cost === 0) flag('zero_shipping_cost');
    if (cost > capCents) flag('over_review_cap');
    for (const c of REVIEW_MONEY_COLUMNS) {
      const v = String(r[c] ?? '').trim() === '' ? 0 : toCents(r[c]);
      if (v === null) bad('review_money_invalid');
      if (v !== 0) flag(FLAG_OF[c]);
    }
    if (expectedStore && String(r['Store']).trim() !== expectedStore) flag('unexpected_store');
    for (const c of ['Provider', 'Service', 'Package', 'Items', 'Zone', 'Weight', 'Weight Unit', 'Store']) {
      const s = String(r[c] ?? '');
      if (s.length > TEXT_MAX || /[\u0000-\u001f]/.test(s) || looksPersonal(s)) bad('field_not_allowed');
    }
    const p = perDate[d.date] || (perDate[d.date] = [0, 0]);
    p[0] += cost; p[1] += 1;
  }
  return { rows: rows.length, perDate, flags };
}

/** Sum segment facts (seal). */
export function sumFacts(list) {
  const perDate = {}, flags = {}; let rows = 0;
  for (const f of list) {
    rows += f.rows;
    for (const [d, [c, n]] of Object.entries(f.perDate)) { const p = perDate[d] || (perDate[d] = [0, 0]); p[0] += c; p[1] += n; }
    for (const [k, n] of Object.entries(f.flags)) flags[k] = (flags[k] || 0) + n;
  }
  return { rows, perDate, flags, cents: Object.values(perDate).reduce((s, [c]) => s + c, 0) };
}

// ─── Acceptance rules ────────────────────────────────────────────────────────

export const REVIEW_FLAGS = ['zero_shipping_cost', 'over_review_cap', 'nonzero_insurance_cost', 'nonzero_duties', 'nonzero_taxes',
  'nonzero_import_fee', 'ship_date_time_not_midnight', 'unexpected_store'];

/**
 * Version-level review reasons (codes only). Any reason → pending_review,
 * nothing activated until an administrator decides.
 */
const DATE_FORMATTERS = new Map();
const dateFormatter = timeZone => DATE_FORMATTERS.get(timeZone)
  || DATE_FORMATTERS.set(timeZone, new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })).get(timeZone);
export function versionReviewReasons({ flags, firstVersion, coverage, from, to, exportedAt, timeZone }) {
  const reasons = [];
  if (firstVersion) reasons.push('first_version');
  for (const f of REVIEW_FLAGS) if (flags[f]) reasons.push(f);
  if (coverage && (from > addDays(coverage.to, 1) || to < addDays(coverage.from, -1))) reasons.push('coverage_gap');
  if (!exportedAt) reasons.push('export_time_unknown');
  else {
    const exportDate = dateFormatter(timeZone).format(new Date(exportedAt));
    if (exportDate <= to) reasons.push('possible_incomplete_trailing_date');
  }
  return reasons;
}

/**
 * Per-date outcome. `owner` is the current owner { versionId, dayHash, groups } or null;
 * `acceptedKeys` is the set of the date's NEW order keys that already have accepted
 * cost on some owned date (the Worker asks D1 for exactly these).
 */
export function classifyDay({ day, owner, acceptedKeys }) {
  if (!owner) return 'new';
  if (owner.dayHash === day.hash) return 'identical';
  const now = new Map(day.groups.map(g => [g[0], g]));
  for (const [k, cents, n] of owner.groups) {
    const g = now.get(k);
    if (!g || g[1] !== cents || g[2] !== n) return 'held';                     // an accepted cost changed or disappeared
  }
  const had = new Set(owner.groups.map(g => g[0]));
  for (const g of day.groups) if (!had.has(g[0]) && acceptedKeys.has(g[0])) return 'held';   // adds to an order that already has cost
  return 'fill_in';
}
