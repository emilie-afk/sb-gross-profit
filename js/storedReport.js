/**
 * storedReport.js — the automatic reports' inputs, rebuilt from stored results (no upload)
 * =======================================================================================
 * The CSV-upload report renders calculator line items (index.html: renderDashboard and the screens
 * it feeds). An automatic report renders the SAME screens from the weekly results the Worker stores:
 * each week's order rows and line rows (GET /v1/snapshot/:week/report-part/:k, the latest PUBLISHED
 * revision). Nothing is recomputed: every amount is a stored amount, only summed.
 *
 *   storedLines(orders, lines)      → line items in the calculator's shape (for the shared screens)
 *   aggregate(weeks, period)        → period totals, breakdowns and a summarize()-shaped summary,
 *                                     from the orders whose business date (Los Angeles) is in the period
 *   periodPlan(kind, key, weekList) → which weeks a week, a calendar month or a date range needs, and its gaps
 *   monthsOf(weekList)              → the calendar months that published weeks touch
 *   rangeKey / rangeOf / checkRange → a custom date range ('YYYY-MM-DD_YYYY-MM-DD'), parsed and validated
 *
 * Rules (automatic reports):
 *   - A custom date range (any days, at most MAX_RANGE_DAYS) follows the month rules exactly.
 *   - A month is a calendar month in Los Angeles time. Orders are assigned by their own business date,
 *     so a week that crosses a month boundary is split; whole weekly totals are never added and
 *     margins are never averaged: every margin is recomputed from the period's amounts.
 *   - Each week contributes its latest published revision only (one snapshot per week).
 *   - Custom dates with "Include provisional data": a week with NO published revision contributes its latest
 *     independently verified revision instead (the Worker marks it provisional). Never both: a week with a
 *     published revision is always read at it. The report is then Provisional, and every provisional day,
 *     its week's shipping-cost coverage, missing costs and publication holds are listed. Reading it publishes nothing.
 *   - A missing cost is never $0: product GP is known-cost GP, and the revenue without a cost is
 *     disclosed. Days not covered by a published week are disclosed; a partial period is never complete.
 *   - Orders dated before PUBLICATION_EARLIEST (the first week with period-accurate costs) are never
 *     counted, whatever a caller passes.
 * Pure; no I/O. Amounts are summed in integer cents.
 */
import { profitabilityStatus, PROFITABILITY_STATUS } from '../shared/metrics.js';
import { normalizeSku } from '../shared/vendorCosts.js';
import { toCode } from '../shared/vendors.js';
import { HPD_CATEGORIES } from '../shared/shippingDiagnostic.js';

export const SUB_RENEWAL_CHANNEL = 'Subscription renewals (prepaid)';
/** GP is reported from this week on (costs before it are not period-accurate). */
export const PUBLICATION_EARLIEST = '2026-08-03';
export const COVERAGE_THRESHOLD = 0.95;

const DAY = 86400000;
const iso = t => new Date(t).toISOString().slice(0, 10);
const ms = d => Date.parse(`${d}T00:00:00Z`);
export const addDays = (d, n) => iso(ms(d) + n * DAY);
export const daysBetween = (a, b) => Math.round((ms(b) - ms(a)) / DAY) + 1;     // inclusive
const c = x => Math.round((Number(x) || 0) * 100);                               // dollars → cents
const d$ = n => Math.round(n) / 100;                                             // cents → dollars
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const P = (s, dflt) => { if (s && typeof s === 'object') return s; try { return s ? JSON.parse(s) : dflt; } catch { return dflt; } };
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

/** Monday (YYYY-MM-DD) of the Monday–Sunday week holding `date`. */
export function mondayOf(date) {
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay();          // 0 = Sunday
  return addDays(date, -((wd + 6) % 7));
}
export function monthRange(month) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) throw new Error('month must be YYYY-MM');
  const [y, m] = month.split('-').map(Number);
  return { from: `${month}-01`, to: iso(Date.UTC(y, m, 0)) };
}
export const weekRange = w => ({ from: w, to: addDays(w, 6) });

/** Custom date ranges: inclusive Los Angeles days, keyed 'YYYY-MM-DD_YYYY-MM-DD'. */
export const MAX_RANGE_DAYS = 366;
export const PERIOD_NOUN = { week: 'week', month: 'month', range: 'date range' };
const realDate = s => isDate(s) && iso(ms(s)) === s;
export const rangeKey = (from, to) => `${from}_${to}`;
export function rangeOf(key) {
  const [from, to] = String(key || '').split('_');
  if (!realDate(from) || !realDate(to)) throw new Error('a date range is YYYY-MM-DD_YYYY-MM-DD');
  if (from > to) throw new Error('a date range starts on or before its end');
  if (daysBetween(from, to) > MAX_RANGE_DAYS) throw new Error(`a date range is at most ${MAX_RANGE_DAYS} days`);
  return { from, to };
}
/** "Oct 10–16, 2026" (years shown once, or on both ends across a new year). */
export function rangeLabel(r) {
  const y = d => d.slice(0, 4), md = d => fmtDay(d);
  if (r.from === r.to) return `${md(r.from)}, ${y(r.from)}`;
  if (y(r.from) !== y(r.to)) return `${md(r.from)}, ${y(r.from)}–${md(r.to)}, ${y(r.to)}`;
  const sameMonth = r.from.slice(0, 7) === r.to.slice(0, 7);
  return `${md(r.from)}–${sameMonth ? Number(r.to.slice(8)) : md(r.to)}, ${y(r.to)}`;
}
/** Days that published weeks cover (from the earliest reporting day), or null when none. */
export function publishedSpan(weekList, { earliest = PUBLICATION_EARLIEST } = {}) {
  const w = weeksOf(weekList, { earliest }).slice().sort();
  if (!w.length) return null;
  return { from: w[0] < earliest ? earliest : w[0], to: addDays(w[w.length - 1], 6) };
}
/**
 * Can this range be opened? → { ok: true, key, range } or { ok: false, message } (plain words for the form).
 * It needs at least one day a published week covers; other days are opened as gaps and disclosed.
 */
export function checkRange(from, to, weekList, { earliest = PUBLICATION_EARLIEST, provisional = false } = {}) {
  if (!realDate(from) || !realDate(to)) return { ok: false, message: 'Choose a start and an end date.' };
  if (from > to) return { ok: false, message: 'The start date is after the end date.' };
  if (daysBetween(from, to) > MAX_RANGE_DAYS) return { ok: false, message: `Choose at most ${MAX_RANGE_DAYS} days.` };
  if (to < earliest) return { ok: false, message: `GP is reported from ${fmtDay(earliest)}, ${earliest.slice(0, 4)}; choose dates from then on.` };
  const key = rangeKey(from, to);
  const plan = periodPlan('range', key, weekList, { earliest, provisional });
  if (!plan.weeks.length) {
    const span = publishedSpan(weekList, { earliest });
    const what = provisional ? 'No published or verified week covers these dates.' : 'No published week covers these dates.';
    return { ok: false, message: span ? `${what} Published reports cover ${rangeLabel(span)}.` : 'No published reports yet.' };
  }
  return { ok: true, key, range: { from, to } };
}
const overlap = (a, b) => { const from = a.from > b.from ? a.from : b.from, to = a.to < b.to ? a.to : b.to; return from <= to ? { from, to } : null; };
const fmtDay = d => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
export const fmtRange = r => (r.from === r.to ? fmtDay(r.from) : `${fmtDay(r.from)}–${fmtDay(r.to)}`);
export const monthLabel = m => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** The latest published revision of a week in /v1/weeks (revisions listed newest first), or null. */
export const publishedOf = w => (w?.revisions || []).find(r => r.status === 'published') || null;
/** The revision a report reads for a week: the published one; with `provisional`, else the Worker's provisional one. */
export const usableOf = (w, { provisional = false } = {}) => publishedOf(w) || (provisional ? (w?.revisions || []).find(r => r.provisional) || null : null);

/** Calendar months (YYYY-MM, newest first) that published weeks touch, never before PUBLICATION_EARLIEST. */
export function monthsOf(weekList, { earliest = PUBLICATION_EARLIEST } = {}) {
  const out = new Set();
  for (const w of weekList || []) {
    if (!publishedOf(w) || !isDate(w.weekStart)) continue;
    const r = overlap(weekRange(w.weekStart), { from: earliest, to: '9999-12-31' });
    if (!r) continue;
    out.add(r.from.slice(0, 7)); out.add(r.to.slice(0, 7));
  }
  return [...out].sort().reverse();
}

/** Published weeks (Monday, newest first) that hold days from PUBLICATION_EARLIEST on: the weeks a report can open. */
export function weeksOf(weekList, { earliest = PUBLICATION_EARLIEST } = {}) {
  return (weekList || []).filter(w => isDate(w.weekStart) && publishedOf(w) && addDays(w.weekStart, 6) >= earliest)
    .map(w => w.weekStart).sort().reverse();
}

/** The neighbouring period of the same kind that has a report (dir -1 = earlier, +1 = later), or null. */
export function adjacentPeriod(kind, key, weekList, dir, opts) {
  if (kind === 'range') {
    // The same number of days right before or after, when a published week covers any of them.
    const r = rangeOf(key), n = daysBetween(r.from, r.to);
    const next = dir > 0 ? { from: addDays(r.to, 1), to: addDays(r.to, n) } : { from: addDays(r.from, -n), to: addDays(r.from, -1) };
    const k = rangeKey(next.from, next.to);
    return periodPlan('range', k, weekList, opts).weeks.length ? k : null;   // opts.provisional: verified weeks count too
  }
  const list = (kind === 'month' ? monthsOf(weekList, opts) : weeksOf(weekList, opts)).slice().sort();   // oldest first
  const i = list.indexOf(key);
  if (i < 0) { const later = list.filter(k => (dir > 0 ? k > key : k < key)); return later.length ? (dir > 0 ? later[0] : later[later.length - 1]) : null; }
  return list[i + dir] ?? null;
}

/**
 * Why a week of a period is not included, in words (codes and counts only). From the week list's newest revision:
 * held below the ShipStation coverage gate ("shipping costs in for 120 of 200 orders (60%); publishes at 95%"),
 * another hold, or no revision yet. `status` (GET /v1/weeks/:week/status), when given, adds what blocks it now:
 * ShipStation waiting for a person to sign in on the reporting laptop, or the first pending step.
 * `pendingText`: { code → words } for the pending codes. → string or null (nothing known).
 */
export function gapReason(g, weekList, status = null, pendingText = {}) {
  if (!g || g.reason !== 'not_published') return null;
  const w = (weekList || []).find(x => x.weekStart === g.weekStart);
  const r = (w?.revisions || [])[0];
  const parts = [];
  const pend = (status?.pending || []).map(p => p.code || p)[0];
  if (pend) parts.push(pendingText[pend] || String(pend).replace(/_/g, ' '));
  else if (!r) parts.push('not computed yet');
  else {
    const hold = r.hold || [];
    const cov = hold.find(h => h.code === 'ss_coverage');
    const sc = r.shippingCoverage;
    if (cov && sc && sc.ordersRequiringCost > 0) {
      const gate = /(\d+(?:\.\d+)?)% threshold/.exec(cov.message || '');
      parts.push(`shipping costs in for ${sc.ordersWithCost} of ${sc.ordersRequiringCost} orders (${Math.floor(sc.ordersWithCost / sc.ordersRequiringCost * 100)}%)${gate ? `; publishes at ${gate[1]}%` : ''}`);
    } else if (cov) parts.push('ShipStation costs below the publication threshold');
    for (const h of hold) if (h !== cov) parts.push(String(h.code || '').replace(/_/g, ' '));
    if (!hold.length && r.status !== 'published') parts.push(r.verification === 'verified' ? 'verified, waiting for publication' : 'verification pending');
  }
  if (status?.attention?.code === 'shipstation_signin_required') parts.push('waiting for ShipStation sign-in on the reporting laptop');
  return parts.filter(Boolean).join(' · ') || null;
}

/**
 * What a period needs. kind 'week' (key = Monday), 'month' (key = YYYY-MM) or 'range' (key = 'YYYY-MM-DD_YYYY-MM-DD').
 * → { kind, key, period, weeks: [{ weekStart, days: {from,to} (inside the period), published }],
 *     gaps: [{ from, to, weekStart, reason }] (days of the period no published week covers) }
 */
export function periodPlan(kind, key, weekList, { earliest = PUBLICATION_EARLIEST, provisional = false } = {}) {
  if (kind !== 'month' && kind !== 'week' && kind !== 'range') throw new Error('kind must be week, month or range');
  const period = kind === 'month' ? monthRange(key) : kind === 'range' ? rangeOf(key) : weekRange(key);
  if (kind === 'week' && mondayOf(key) !== key) throw new Error('a week starts on a Monday');
  const byWeek = new Map((weekList || []).map(w => [w.weekStart, w]));
  const weeks = [], gaps = [];
  for (let w = mondayOf(period.from); w <= period.to; w = addDays(w, 7)) {
    const days = overlap(weekRange(w), period);
    const early = overlap(days, { from: '0000-01-01', to: addDays(earliest, -1) });
    if (early) gaps.push({ ...early, weekStart: w, reason: 'before_reporting' });
    const counted = overlap(days, { from: earliest, to: '9999-12-31' });
    if (!counted) continue;
    const published = usableOf(byWeek.get(w), { provisional: provisional && kind === 'range' });
    if (published) weeks.push({ weekStart: w, days: counted, published, provisional: !!published.provisional });
    else gaps.push({ ...counted, weekStart: w, reason: 'not_published' });
  }
  return { kind, key, period, weeks, gaps, earliest, provisional: !!provisional && kind === 'range' };
}

/**
 * Stored order and line rows (snake_case, as the Worker stores them) → line items in the calculator's
 * shape, so the CSV report's screens render them unchanged. Order-level amounts (Shopify net revenue,
 * shipping collected and paid) sit on each order's first line, as the calculator puts them.
 * Missing costs stay null (never $0): lineCogs, lineGp and lineNetGp are null for those lines.
 */
export function storedLines(orders, lines, skuVendors = {}, { refundsNotPerOrder = 0 } = {}) {
  const byName = new Map(orders.map(o => [o.order_name, o]));
  const seen = new Set(), out = [], shareBasis = new Map();
  const sorted = [...lines].sort((a, b) => (a.order_name < b.order_name ? -1 : a.order_name > b.order_name ? 1 : a.line_index - b.line_index));
  for (const l of sorted) {
    const o = byName.get(l.order_name);
    if (!o) continue;
    const flags = P(l.flags, {}) || {};
    const first = !seen.has(l.order_name); seen.add(l.order_name);
    const missing = !!l.missing_cost && !!flags.isProductLine;
    const lineRevenue = flags.isRoute ? (l.route_collected ?? 0) : (l.contract_revenue ?? 0);
    const lineCogs = missing ? null : (flags.isRoute ? (l.route_remitted ?? 0) : (l.line_cogs ?? 0));
    const lineGp = lineCogs === null ? null : d$(c(lineRevenue) - c(lineCogs));
    const shipCollected = first ? o.ship_collected : null;
    const shipPaid = first ? o.ship_paid : null;
    const shipPaidSS = first ? (o.ship_paid_ss ?? null) : null, shipPaidHP = first ? (o.ship_paid_hp ?? null) : null;
    const lr = first && o.ship_paid !== null && o.ship_paid !== undefined ? d$(c(o.ship_paid) - c(o.ship_paid_ss) - c(o.ship_paid_hp)) : null;
    // The calculator's revenue-share basis for subscription shipping: the line price less its line discount, before
    // any refund and before order discounts are allocated (cents; see subscriptionFields).
    shareBasis.set(out.length, Math.max(0, flags.isRoute ? c(l.route_collected) + c(l.refund_allocated)
      : flags.isGiftCard || flags.isInfluencerSample ? c((l.unit_price ?? 0) * (l.qty ?? 0))
      : c(l.contract_revenue) + c(l.discount_allocated) + c(l.refund_allocated)));
    out.push({
      orderNum: l.order_name, date: o.business_date, source: flags.isSubRenewal ? (o.channel || null) : (l.channel || o.channel || null),
      // Weeks saved before the vendor codes carry full names: read them as codes so old and new weeks group together.
      store: l.store ? toCode(l.store) : null, sku: l.sku || '', product: l.product || '', vendor: toCode(l.vendor_key || skuVendors[normalizeSku(l.sku)] || ''), vendorKey: l.vendor_key ? toCode(l.vendor_key) : null,
      qty: l.qty ?? 0, unitPrice: l.unit_price ?? null, unitCost: l.unit_cost ?? null,
      lineRevenue, lineCogs, lineGp, lineGpPct: lineGp !== null && lineRevenue ? Math.round(lineGp / lineRevenue * 1000) / 10 : null,
      orderTotal: first ? (o.shopify_net_revenue ?? 0) : 0,
      costSource: missing ? 'COST MISSING' : (l.cost_source || ''), costMatchType: l.cost_match_type || null, missingCost: missing,
      orderCat: o.order_cat || '', shipCollected, shipPaid, shipPaidSS, shipPaidHP, shipPaidLR: lr !== null && lr > 0 ? lr : (first ? 0 : null),
      shipDelta: first && shipCollected !== null && shipCollected !== undefined && shipPaid !== null && shipPaid !== undefined ? d$(c(shipCollected) - c(shipPaid)) : null,
      shipNote: first ? shipNoteOf(o) : null,
      isFreeShip: first && o.ship_collected === 0 && o.requires_ss_rate ? 'YES' : '',
      isRoute: !!flags.isRoute, isGiftCard: !!flags.isGiftCard, isDigital: !!flags.isDigital, isSubRenewal: !!flags.isSubRenewal,
      isInfluencerSample: !!flags.isInfluencerSample, isProductLine: !!flags.isProductLine, subMonths: subMonthsOf(l.sku),
      profitabilityStatus: o.profitability_status || null, shippingExpenseStatus: o.shipping_expense_status || null,
      refundAllocated: l.refund_allocated ?? 0, refundSource: l.refund_source || null,
      ...(first ? { orderOperatingRevenue: o.operating_revenue ?? null, orderOperatingGp: o.operating_gp ?? null } : {}),
    });
  }
  // Refunds per order: the shares stored on its lines (already netted from revenue; summed, never subtracted
  // again). When the week refunded money beyond product revenue that is not stored per order, an order with
  // no product revenue and no line refund cannot be shown to have had no refund: its status is unknown.
  const lineRefund = new Map(), productBefore = new Map();
  for (const li of out) {
    lineRefund.set(li.orderNum, (lineRefund.get(li.orderNum) || 0) + c(li.refundAllocated));
    if (li.isProductLine) productBefore.set(li.orderNum, (productBefore.get(li.orderNum) || 0) + c(li.lineRevenue) + c(li.refundAllocated));
  }
  const seenFirst = new Set();
  for (const li of out) {
    if (seenFirst.has(li.orderNum)) continue;
    seenFirst.add(li.orderNum);
    li.orderRefund = d$(lineRefund.get(li.orderNum) || 0);
    if (c(refundsNotPerOrder) > 0 && !(lineRefund.get(li.orderNum) > 0) && !(productBefore.get(li.orderNum) > 0)) li.refundUnknown = true;
  }
  // Net GP: the order's shipping difference spread over its lines by revenue (the calculator's post-pass).
  const groups = new Map(), basisOf = new Map(out.map((li, i) => [li, shareBasis.get(i)]));
  for (const li of out) (groups.get(li.orderNum) || groups.set(li.orderNum, []).get(li.orderNum)).push(li);
  for (const g of groups.values()) {
    const delta = g[0].shipDelta ?? 0, tot = g.reduce((s, li) => s + (li.lineRevenue || 0), 0);
    for (const li of g) {
      const share = tot > 0 ? (li.lineRevenue || 0) / tot : 1 / g.length;
      li.lineNetGp = li.lineGp !== null ? Math.round((li.lineGp + Math.round(delta * share * 100) / 100) * 100) / 100 : null;
      li.lineNetGpPct = li.lineNetGp !== null && li.lineRevenue ? Math.round(li.lineNetGp / li.lineRevenue * 1000) / 10 : null;
    }
    subscriptionFields(g, byName.get(g[0].orderNum), basisOf);
  }
  return markSeveralSubscriptions(out);
}

// ─── Subscription fields (Subscription P&L and the Subscriptions table) ──────────────────────────────────
// The calculator's per-delivery subscription fields, rebuilt from the stored order and lines so automatic
// reports get the same Subscription P&L as CSV uploads (shared/calculator.js, the isSubSku block):
//   subMonths     the SKU's months (the last number of 1–24 in a SUB/GSUB SKU; 1 otherwise)
//   subShipMo     the order's shipping × this line's revenue share ÷ months. The stored ship_collected is the
//                 order's shipping ÷ the first line's months (the calculator's rule), so it is multiplied back.
//   subSSCostMo   the order's ShipStation label cost (each box ships on its own label; null when not in yet)
//   expSubShipMo  the expected monthly shipping fee; subShipLoss = label cost − shipping collected per month
// Revenue share: the calculator's basis, each line's price less its own line discount, before refunds and before
// order-level discounts (the CSV calculator never spreads those). Stored lines keep it exactly: contract revenue
// + allocated order discount + allocated refund = price × qty − line discount (Route: collected + refund). Gift-card
// and influencer-sample lines keep no line discount, so their price × qty is used. One known rounding limit: the
// stored ship_collected is rounded per month, so a multi-month subscription sharing an order with regular items
// can differ by 1¢. Orders with several subscriptions are not split at all (below).
// Orders with several subscription lines: shipping is not split (markSeveralSubscriptions, both paths).
const SUB_SHIP_NORMAL = 6.99, SUB_SHIP_POT = 7.99;                    // calculator.js: rates effective until Jul 2026
export const isSubSku = sku => /^(SUB|GSUB)/i.test(sku || '');
export function subMonthsOf(sku) {
  const s = String(sku || '').toUpperCase();
  if (!isSubSku(s)) return 1;
  const nums = s.split('-').map(p => parseInt(p, 10)).filter(n => !isNaN(n) && n >= 1 && n <= 24);
  return nums.length ? nums[nums.length - 1] : 1;
}
/**
 * Orders with more than one subscription line: their shipping split is unavailable, on CSV and automatic reports
 * alike. Shopify's export fills Shipping on an order's first row only, so the CSV calculator gives every later
 * subscription $0 of the order's shipping, and the label cost is the whole order's on each line; the stored rows
 * keep the order's shipping only per month of the first line. Neither gives each subscription's own share, so
 * shipping collected, label cost and loss per month are null (left out of the averages) and the lines are marked
 * subShipUnavailable. Months and the expected fee are the SKU's own and stay. Mutates and returns `lines`.
 */
export function markSeveralSubscriptions(lines) {
  const subs = new Map();
  for (const li of lines) if (isSubSku(li.sku)) subs.set(li.orderNum, (subs.get(li.orderNum) || 0) + 1);
  for (const li of lines) {
    if (!isSubSku(li.sku)) continue;
    li.subShipUnavailable = subs.get(li.orderNum) > 1;
    if (li.subShipUnavailable) Object.assign(li, { subShipMo: null, subSSCostMo: null, subShipLoss: null });
  }
  return lines;
}
function subscriptionFields(g, o, basisOf) {
  for (const li of g) Object.assign(li, { subShipMo: null, expSubShipMo: null, subSSCostMo: null, subShipLoss: null });
  if (!o || !g.some(li => isSubSku(li.sku))) return;
  const rawShip = c(o.ship_collected) * subMonthsOf(g[0].sku);                    // cents, the whole order's shipping
  const basis = li => basisOf.get(li) ?? 0;
  const tot = g.reduce((s, li) => s + basis(li), 0);
  const ss = o.ship_paid_ss !== null && o.ship_paid_ss !== undefined && Number(o.ship_paid_ss) > 0 ? Number(o.ship_paid_ss) : null;
  for (const li of g) {
    if (!isSubSku(li.sku)) continue;
    const share = tot > 0 ? Math.min(basis(li) / tot, 1) : 0;
    li.subShipMo = Math.round(rawShip * share / li.subMonths) / 100;
    const up = li.sku.toUpperCase();
    li.expSubShipMo = up.includes('POT') || up.includes('UPGRADE') ? SUB_SHIP_POT : SUB_SHIP_NORMAL;
    if (ss !== null) { li.subSSCostMo = Math.round(ss * 100) / 100; li.subShipLoss = d$(c(li.subSSCostMo) - c(li.subShipMo)); }
  }
}

const SHIP_NOTE = { missing_shipstation_rate: 'No ShipStation cost yet', pass_through: 'HPD pass-through (Shopify shipping)' };
function shipNoteOf(o) {
  if (SHIP_NOTE[o.shipping_expense_status]) return SHIP_NOTE[o.shipping_expense_status];
  if (o.hpd_shipping_basis === 'hpd_actual') return 'HPD actual';
  return o.shipping_expense_source ? String(o.shipping_expense_source).replace(/_/g, ' ') : (o.order_cat || null);
}

function bucket(key) { return { key, units: 0, lines: 0, known: 0, cogs: 0, missing: 0, missingUnits: 0, missingLines: 0 }; }
function finish(b) {
  const knownCostRevenue = d$(b.known), knownCogs = d$(b.cogs), knownCostGp = d$(b.known - b.cogs);
  return { key: b.key, units: b.units, lines: b.lines, knownCostRevenue, knownCogs, knownCostGp, knownCostMargin: pct(b.known - b.cogs, b.known),
    missingCostRevenue: d$(b.missing), missingCostUnits: b.missingUnits, missingCostLines: b.missingLines,
    costCoverageByRevenue: pct(b.known, b.known + b.missing), coverageStatus: b.missingLines ? 'incomplete' : 'complete' };
}

/**
 * Period results from stored rows. `weeks`: [{ weekStart, snapshotId, revision, orders, lines, skuVendors?, head? }]
 * (one entry per week: its latest published revision). `period`: { from, to } (inclusive, LA dates).
 * Only orders whose business date is inside the period (and not before `earliest`, PUBLICATION_EARLIEST
 * unless a test passes another) count.
 */
export function aggregate(weeks, period, { earliest = PUBLICATION_EARLIEST } = {}) {
  const ids = new Set();
  for (const w of weeks) {
    if (ids.has(w.weekStart)) throw new Error(`week ${w.weekStart} given twice: one revision per week`);
    ids.add(w.weekStart);
  }
  const lo = period.from > earliest ? period.from : earliest;
  const inPeriod = o => isDate(o.business_date) && o.business_date >= lo && o.business_date <= period.to;
  const T = { orders: 0, shopifyNet: 0, route: 0, opRev: 0, cogs: 0, shipCollected: 0, shipExpense: 0, ss: 0, hp: 0,
              requiring: 0, valid: 0, passThrough: 0, hpdActual: 0, known: 0, missing: 0, missingLines: 0, missingUnits: 0, units: 0 };
  const dims = { channel: new Map(), vendor: new Map(), store: new Map() };
  const shipByType = {}, byChannelStore = {};
  const shipByVendor = { ShipStation: { paid: 0, orders: 0 }, 'HP Dropship': { paid: 0, orders: 0 }, LR: { paid: 0, orders: 0 } };
  const allOrders = [], allLines = [], daysWithOrders = new Set();
  for (const w of weeks) {
    const orders = (w.orders || []).filter(inPeriod);
    const names = new Set(orders.map(o => o.order_name));
    const lines = (w.lines || []).filter(l => names.has(l.order_name));
    allOrders.push(...orders); allLines.push(...lines);
    for (const o of orders) {
      daysWithOrders.add(o.business_date);
      T.orders++; T.shopifyNet += c(o.shopify_net_revenue); T.route += c(o.route_collected); T.opRev += c(o.operating_revenue);
      T.cogs += c(o.known_product_cogs); T.shipCollected += c(o.ship_collected); T.shipExpense += c(o.ship_paid);
      T.ss += c(o.ship_paid_ss); T.hp += c(o.ship_paid_hp);
      if (o.requires_ss_rate) { T.requiring++; if (o.has_valid_ss_rate) T.valid++; }
      // HP Dropship orders: actual when HPD reported the cost, otherwise assumed (pass-through), as the week counts them.
      if (HPD_CATEGORIES.has(o.order_cat)) { if (o.hpd_shipping_basis === 'hpd_actual') T.hpdActual++; else T.passThrough++; }
      if (o.ship_collected !== null && o.ship_collected !== undefined) {
        const t = o.order_cat || 'Other';
        const s = shipByType[t] ||= { collected: 0, paid: 0, delta: 0, orders: 0, noDelta: 0 };
        s.collected += c(o.ship_collected); s.orders++;
        if (o.ship_paid !== null && o.ship_paid !== undefined) { s.paid += c(o.ship_paid); s.delta += c(o.ship_collected) - c(o.ship_paid); } else s.noDelta++;
      }
      const lr = c(o.ship_paid) - c(o.ship_paid_ss) - c(o.ship_paid_hp);
      for (const [k, v] of [['ShipStation', c(o.ship_paid_ss)], ['HP Dropship', c(o.ship_paid_hp)], ['LR', lr > 0 ? lr : 0]]) {
        shipByVendor[k].paid += v; if (v > 0) shipByVendor[k].orders++;
      }
    }
    for (const l of lines) {
      const f = P(l.flags, {}) || {};
      if (!f.isProductLine) continue;
      const missing = !!l.missing_cost, rev = c(l.contract_revenue), cogs = c(l.line_cogs);
      T.units += l.qty || 0;
      if (missing) { T.missing += rev; T.missingLines++; T.missingUnits += l.qty || 0; } else T.known += rev;
      const keys = { channel: f.isSubRenewal ? SUB_RENEWAL_CHANNEL : (l.channel || 'Unknown'), vendor: toCode(l.vendor_key || (w.skuVendors || {})[normalizeSku(l.sku)] || 'Unknown'), store: toCode(l.store || 'Unknown') };
      for (const [dim, key] of Object.entries(keys)) {
        const m = dims[dim]; if (!m.has(key)) m.set(key, bucket(key));
        const b = m.get(key); b.units += l.qty || 0; b.lines++;
        if (missing) { b.missing += rev; b.missingUnits += l.qty || 0; b.missingLines++; } else { b.known += rev; b.cogs += cogs; }
      }
      const cs = (byChannelStore[keys.channel] ||= {}), st = (cs[keys.store] ||= { known: 0, missing: 0, cogs: 0 });
      if (missing) st.missing += rev; else { st.known += rev; st.cogs += cogs; }
    }
  }
  const opGp = T.opRev - T.cogs - T.shipExpense;
  const breakdowns = Object.fromEntries(Object.entries(dims).map(([k, m]) => [k, [...m.values()].map(finish)
    .sort((a, b) => b.knownCostRevenue - a.knownCostRevenue || (a.key < b.key ? -1 : 1))]));
  const costsComplete = T.missingLines === 0, shippingComplete = T.valid === T.requiring;
  const totals = {
    orders: T.orders,
    operatingRevenue: d$(T.opRev), shopifyNetRevenueInclPassThrough: d$(T.shopifyNet), routeCollected: d$(T.route),
    knownProductCogs: d$(T.cogs), knownCostProductRevenue: d$(T.known), knownCostProductGp: d$(T.known - T.cogs),
    knownCostProductMargin: pct(T.known - T.cogs, T.known),
    missingCostRevenue: d$(T.missing), missingCostLines: T.missingLines, missingCostUnits: T.missingUnits,
    costCoverageByRevenue: pct(T.known, T.known + T.missing), costCoverageByUnits: pct(T.units - T.missingUnits, T.units),
    shippingCollected: d$(T.shipCollected), shippingExpense: d$(T.shipExpense), shipStationExpense: d$(T.ss), hpdShippingExpense: d$(T.hp),
    operatingGpAfterShipping: d$(opGp), operatingGpMargin: pct(opGp, T.opRev),
    ordersRequiringShipStationRate: T.requiring, ordersWithValidShipStationRate: T.valid,
    shipStationExpenseCoverage: pct(T.valid, T.requiring), hpdOrdersPassThrough: T.passThrough, hpdOrdersActual: T.hpdActual,
    profitabilityStatus: profitabilityStatus(costsComplete, shippingComplete, T.passThrough > 0),
  };
  // The summarize() shape the shared screens read. Product GP is known-cost GP: revenue without a cost is
  // carried separately (missingRevenue) and never counted as profit.
  const toS = b => ({ revenue: d$(b.known + b.missing), knownRevenue: d$(b.known), missingRevenue: d$(b.missing), cogs: d$(b.cogs),
                      gp: d$(b.known - b.cogs), margin: pct(b.known - b.cogs, b.known) });
  const byChannel = Object.fromEntries([...dims.channel.values()].map(b => [b.key, toS(b)]));
  const byStore = Object.fromEntries([...dims.store.values()].map(b => [b.key, { ...toS(b), orders: new Set(allLines.filter(l => toCode(l.store || 'Unknown') === b.key).map(l => l.order_name)).size }]));
  const byCS = Object.fromEntries(Object.entries(byChannelStore).map(([ch, m]) => [ch, Object.fromEntries(Object.entries(m).map(([st, v]) =>
    [st, { revenue: d$(v.known + v.missing), cogs: d$(v.cogs), gp: d$(v.known - v.cogs) }]))]));
  const summary = {
    totalRevenue: totals.operatingRevenue, productRevenue: d$(T.known + T.missing), totalShipCollected: totals.shippingCollected,
    totalShipPaid: totals.shippingExpense, totalCogs: totals.knownProductCogs, totalGp: totals.operatingGpAfterShipping,
    gpPct: totals.operatingGpMargin ?? 0, missingCost: T.missingLines, byStore, byChannel, byChannelStore: byCS,
    shipByType: Object.fromEntries(Object.entries(shipByType).map(([k, v]) => [k, { collected: d$(v.collected), paid: d$(v.paid), delta: d$(v.delta), orders: v.orders, noDelta: v.noDelta }])),
    shipByVendor: Object.fromEntries(Object.entries(shipByVendor).map(([k, v]) => [k, { paid: d$(v.paid), orders: v.orders }])),
  };
  // Refunds. Stored results keep each order's refund only as its line shares (product and Route). A refund
  // beyond an order's product revenue (shipping, other) is kept per WEEK (the revenue bridge), not per order:
  // it counts in a period only when the whole week is inside it; a week crossing the period boundary is
  // disclosed and assigned to neither side (its order dates are unknown).
  let allocated = 0, inside = 0;
  for (const l of allLines) allocated += c(l.refund_allocated);
  const boundary = [];
  for (const w of weeks) {
    const b = c(w.head?.revenueBridge?.components?.refundsBeyondProductRevenue);
    if (!(b > 0)) continue;
    const wr = weekRange(w.weekStart);
    if (wr.from >= lo && wr.to <= period.to) inside += b;
    else boundary.push({ weekStart: w.weekStart, amount: d$(b), days: overlap(wr, { from: lo, to: period.to }) });
  }
  const refunds = { allocated: d$(allocated), notPerOrder: d$(inside), total: d$(allocated + inside), boundary, complete: boundary.length === 0 };
  return { period, totals, breakdowns, summary, refunds, orders: allOrders, lines: allLines, daysWithOrders: daysWithOrders.size };
}

/**
 * The disclosures an automatic report shows with its figures (plain sentences, no amounts withheld):
 * gaps (days no published week covers), partial period, cost and shipping coverage, provisional status,
 * and each included week's revision, verification and correction flags.
 * `weekInfo`: [{ weekStart, revision, verification, catalog, flagsText?, partialWeek? }].
 */
export function disclosures({ plan, totals, weekInfo = [] }) {
  const out = [];
  const noun = PERIOD_NOUN[plan.kind] || plan.kind;
  const periodDays = daysBetween(plan.period.from, plan.period.to);
  const covered = plan.weeks.reduce((n, w) => n + daysBetween(w.days.from, w.days.to), 0);
  const complete = covered === periodDays;
  if (!complete) out.push({ kind: 'partial_period', tone: 'warn',
    text: plan.provisional
      ? `Usable reports cover ${covered} of ${periodDays} days, including published and verified provisional data. Dates without usable data are listed below and excluded from totals.`
      : `Partial ${noun}: published weeks cover ${covered} of ${periodDays} days (${plan.weeks.map(w => fmtRange(w.days)).join(', ') || 'none'}). Figures are for those days only.` });
  for (const g of plan.gaps) out.push({ kind: g.reason, tone: 'warn', text: g.reason === 'before_reporting'
    ? `${fmtRange(g)} not included: GP is not reported before ${fmtDay(plan.earliest || PUBLICATION_EARLIEST)} (costs before then are not period-accurate).`
    : `${fmtRange(g)} not included: the week of ${fmtDay(g.weekStart)} has no ${plan.provisional ? 'published or verified' : 'published'} report${g.detail ? ` (${g.detail})` : ''}.` });
  if (plan.weeks.some(w => w.days.from !== w.weekStart || w.days.to !== addDays(w.weekStart, 6)))
    out.push({ kind: 'split_weeks', tone: 'info', text: `Weeks crossing the ${noun} boundary are split by order date; only orders dated inside the ${noun} count.` });
  if (totals.missingCostLines) out.push({ kind: 'missing_cost', tone: 'warn',
    text: `Product cost missing on ${totals.missingCostLines} line${totals.missingCostLines === 1 ? '' : 's'} (${money(totals.missingCostRevenue)} of revenue; ${totals.costCoverageByRevenue ?? '—'}% of product revenue has a cost). Operating GP includes that revenue but deducts no cost for it, so it is overstated by the missing costs. Product GP in the channel and vendor tables counts only lines with a known cost.` });
  const need = totals.ordersRequiringShipStationRate, have = totals.ordersWithValidShipStationRate;
  if (need && have < need) out.push({ kind: 'missing_shipping', tone: have / need < COVERAGE_THRESHOLD ? 'neg' : 'warn',
    text: `Shipping cost missing on ${need - have} of ${need} orders (${pct(have, need)}% covered). Their shipping expense is not in GP (not counted as $0), so GP after shipping is overstated.` });
  if (totals.hpdOrdersPassThrough) out.push({ kind: 'hpd_pass_through', tone: 'info',
    text: `HP Dropship shipping assumed equal to Shopify shipping collected on ${totals.hpdOrdersPassThrough} order${totals.hpdOrdersPassThrough === 1 ? '' : 's'} (pass-through; HPD actuals not received).` });
  const unpublished = weekInfo.filter(w => w.provisional);
  if (unpublished.length) {
    out.push({ kind: 'provisional_data', tone: 'warn', text: `Includes unpublished data: ${unpublished.map(w => fmtRange(w.days || weekRange(w.weekStart))).join(', ')} ${unpublished.length === 1 ? 'comes' : 'come'} from ${unpublished.length === 1 ? 'a week' : 'weeks'} not yet published (the latest independently verified revision). These figures can still change; the weekly publication checks are unchanged.` });
    for (const w of unpublished) {
      const c = w.coverage || {};
      const bits = [`${fmtRange(w.days || weekRange(w.weekStart))} (week of ${fmtDay(w.weekStart)}, revision ${w.revision}, verified, not published)`];
      if (c.ordersRequiringShipStationRate) bits.push(`shipping cost on ${c.ordersWithValidShipStationRate} of ${c.ordersRequiringShipStationRate} orders (${pct(c.ordersWithValidShipStationRate, c.ordersRequiringShipStationRate)}%)`);
      if (c.missingCostLines) bits.push(`product cost missing on ${c.missingCostLines} line${c.missingCostLines === 1 ? '' : 's'} (${money(c.missingCostRevenue)})`);
      bits.push(w.hold?.length ? `held by: ${w.hold.map(h => h.message || h.code).join('; ')}` : 'not published yet');
      out.push({ kind: 'provisional_week', tone: 'warn', text: bits.join(' · ') });
    }
  }
  for (const w of weekInfo) {
    const bits = [`week of ${fmtDay(w.weekStart)}: revision ${w.revision}${w.provisional ? ' (provisional, not published)' : ''}`, w.verification === 'verified' ? 'independently verified' : `verification ${String(w.verification || 'pending').replace(/_/g, ' ')}`];
    if (w.catalog?.basis === 'cost_restatement') bits.push('costs corrected (audited cost correction)');
    if (w.catalog?.freshness?.status === 'reused_accepted') bits.push('pinned cost catalog accepted for this period');
    if (w.partialWeek) bits.push(`partial week (orders from ${w.partialWeek.from})`);
    if (w.flagsText) bits.push(w.flagsText);
    out.push({ kind: 'week', tone: 'info', text: bits.join(' · ') });
  }
  const provisional = !complete || totals.profitabilityStatus !== PROFITABILITY_STATUS.COMPLETE || weekInfo.some(w => w.verification !== 'verified') || unpublished.length > 0;
  const unpubText = 'Provisional: includes unpublished data';
  return { items: out, complete, covered, periodDays, provisional, includesUnpublished: unpublished.length > 0,
    provisionalDays: unpublished.map(w => w.days || weekRange(w.weekStart)),
    headline: provisional ? 'Provisional operating GP after shipping' : 'Operating GP after shipping',
    status: unpublished.length ? (complete ? unpubText : `${unpubText} · partial ${noun}`) : (!complete ? `Partial ${noun}` : (provisional ? 'Provisional' : 'Complete')) };
}

/** One week's shipping-cost coverage and missing costs over the days it contributes (for provisional notes). */
export function weekCoverage(week, days, opts) {
  const t = aggregate([week], days, opts).totals;
  return { ordersRequiringShipStationRate: t.ordersRequiringShipStationRate, ordersWithValidShipStationRate: t.ordersWithValidShipStationRate,
    missingCostLines: t.missingCostLines, missingCostRevenue: t.missingCostRevenue };
}

/**
 * The rows a custom-date report's exports start with: what the figures are, which days they cover, which days
 * are provisional or missing, and every warning. → CSV text ending in a blank line (prepended to the export).
 */
export function exportPreamble({ label, plan, disc }) {
  const q = v => { const t = String(v ?? ''); return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const rows = [['Report', `${label} (Los Angeles dates)`], ['Status', disc.status],
    ['Included dates', plan.weeks.map(w => fmtRange(w.days)).join('; ') || 'none'],
    ['Provisional dates (unpublished)', disc.provisionalDays?.length ? disc.provisionalDays.map(fmtRange).join('; ') : 'none'],
    ['Missing dates (no usable data; not counted)', plan.gaps.length ? plan.gaps.map(g => `${fmtRange(g)} (${g.reason === 'before_reporting' ? 'before reporting starts' : g.detail || (plan.provisional ? 'no published or verified report' : 'not published')})`).join('; ') : 'none'],
    ...disc.items.filter(i => i.tone !== 'info' || i.kind === 'week').map(i => ['Note', i.text])];
  return rows.map(r => r.map(q).join(',')).join('\r\n') + '\r\n\r\n';
}

const money = n => (n === null || n === undefined || Number.isNaN(n)) ? '—'
  : (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Load a period's stored rows: each planned week's latest published revision, part by part.
 * `client`: { snapshot(week), reportPart(week, k, snapshotId), weekStatus?(week) }. Bounded: ≤ 40 orders
 * per request, a few requests in flight. → { plan, weeks: [{ weekStart, snapshotId, revision, head, orders, lines }] }
 */
export async function loadPeriod(client, plan, { concurrency = 4 } = {}) {
  const weeks = [];
  for (const w of plan.weeks) {
    // A provisional plan reads unpublished weeks with ?provisional=1; the Worker still answers a published
    // revision whenever the week has one (it may have been published since the list was read).
    const prov = !!plan.provisional;
    const head = await client.snapshot(w.weekStart, prov);
    const first = await client.reportPart(w.weekStart, 0, head.snapshotId, prov);
    const parts = [first];
    const ks = Array.from({ length: Math.max(0, first.parts - 1) }, (_, i) => i + 1);
    for (let i = 0; i < ks.length; i += concurrency)
      parts.push(...await Promise.all(ks.slice(i, i + concurrency).map(k => client.reportPart(w.weekStart, k, head.snapshotId, prov))));
    weeks.push({ weekStart: w.weekStart, snapshotId: head.snapshotId, revision: head.revision, head, days: w.days,
      provisional: head.status !== 'published' && !!head.provisional, hold: head.provisional ? (head.hold || []) : [],
      orders: parts.flatMap(p => p.o?.orders || []), lines: parts.flatMap(p => p.l?.lines || []), skuVendors: first.skuVendors || {} });
  }
  return { plan, weeks };
}
