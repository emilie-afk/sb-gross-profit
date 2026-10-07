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
 *   periodPlan(kind, key, weekList) → which weeks a week or a calendar month needs, and its gaps
 *   monthsOf(weekList)              → the calendar months that published weeks touch
 *
 * Rules (automatic reports):
 *   - A month is a calendar month in Los Angeles time. Orders are assigned by their own business date,
 *     so a week that crosses a month boundary is split; whole weekly totals are never added and
 *     margins are never averaged: every margin is recomputed from the period's amounts.
 *   - Each week contributes its latest published revision only (one snapshot per week).
 *   - A missing cost is never $0: product GP is known-cost GP, and the revenue without a cost is
 *     disclosed. Days not covered by a published week are disclosed; a partial period is never complete.
 *   - Orders dated before PUBLICATION_EARLIEST (the first week with period-accurate costs) are never
 *     counted, whatever a caller passes.
 * Pure; no I/O. Amounts are summed in integer cents.
 */
import { profitabilityStatus, PROFITABILITY_STATUS } from '../shared/metrics.js';
import { normalizeSku } from '../shared/vendorCosts.js';
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
const overlap = (a, b) => { const from = a.from > b.from ? a.from : b.from, to = a.to < b.to ? a.to : b.to; return from <= to ? { from, to } : null; };
const fmtDay = d => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
export const fmtRange = r => (r.from === r.to ? fmtDay(r.from) : `${fmtDay(r.from)}–${fmtDay(r.to)}`);
export const monthLabel = m => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** The latest published revision of a week in /v1/weeks (revisions listed newest first), or null. */
export const publishedOf = w => (w?.revisions || []).find(r => r.status === 'published') || null;

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
  const list = (kind === 'month' ? monthsOf(weekList, opts) : weeksOf(weekList, opts)).slice().sort();   // oldest first
  const i = list.indexOf(key);
  if (i < 0) { const later = list.filter(k => (dir > 0 ? k > key : k < key)); return later.length ? (dir > 0 ? later[0] : later[later.length - 1]) : null; }
  return list[i + dir] ?? null;
}

/**
 * What a period needs. kind 'week' (key = Monday) or 'month' (key = YYYY-MM).
 * → { kind, key, period, weeks: [{ weekStart, days: {from,to} (inside the period), published }],
 *     gaps: [{ from, to, weekStart, reason }] (days of the period no published week covers) }
 */
export function periodPlan(kind, key, weekList, { earliest = PUBLICATION_EARLIEST } = {}) {
  const period = kind === 'month' ? monthRange(key) : weekRange(key);
  if (kind !== 'month' && kind !== 'week') throw new Error('kind must be week or month');
  if (kind === 'week' && mondayOf(key) !== key) throw new Error('a week starts on a Monday');
  const byWeek = new Map((weekList || []).map(w => [w.weekStart, w]));
  const weeks = [], gaps = [];
  for (let w = mondayOf(period.from); w <= period.to; w = addDays(w, 7)) {
    const days = overlap(weekRange(w), period);
    const early = overlap(days, { from: '0000-01-01', to: addDays(earliest, -1) });
    if (early) gaps.push({ ...early, weekStart: w, reason: 'before_reporting' });
    const counted = overlap(days, { from: earliest, to: '9999-12-31' });
    if (!counted) continue;
    const published = publishedOf(byWeek.get(w));
    if (published) weeks.push({ weekStart: w, days: counted, published });
    else gaps.push({ ...counted, weekStart: w, reason: 'not_published' });
  }
  return { kind, key, period, weeks, gaps, earliest };
}

/**
 * Stored order and line rows (snake_case, as the Worker stores them) → line items in the calculator's
 * shape, so the CSV report's screens render them unchanged. Order-level amounts (Shopify net revenue,
 * shipping collected and paid) sit on each order's first line, as the calculator puts them.
 * Missing costs stay null (never $0): lineCogs, lineGp and lineNetGp are null for those lines.
 */
export function storedLines(orders, lines, skuVendors = {}, { refundsNotPerOrder = 0 } = {}) {
  const byName = new Map(orders.map(o => [o.order_name, o]));
  const seen = new Set(), out = [];
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
    out.push({
      orderNum: l.order_name, date: o.business_date, source: flags.isSubRenewal ? (o.channel || null) : (l.channel || o.channel || null),
      store: l.store || null, sku: l.sku || '', product: l.product || '', vendor: l.vendor_key || skuVendors[normalizeSku(l.sku)] || '', vendorKey: l.vendor_key || null,
      qty: l.qty ?? 0, unitPrice: l.unit_price ?? null, unitCost: l.unit_cost ?? null,
      lineRevenue, lineCogs, lineGp, lineGpPct: lineGp !== null && lineRevenue ? Math.round(lineGp / lineRevenue * 1000) / 10 : null,
      orderTotal: first ? (o.shopify_net_revenue ?? 0) : 0,
      costSource: missing ? 'COST MISSING' : (l.cost_source || ''), costMatchType: l.cost_match_type || null, missingCost: missing,
      orderCat: o.order_cat || '', shipCollected, shipPaid, shipPaidSS, shipPaidHP, shipPaidLR: lr !== null && lr > 0 ? lr : (first ? 0 : null),
      shipDelta: first && shipCollected !== null && shipCollected !== undefined && shipPaid !== null && shipPaid !== undefined ? d$(c(shipCollected) - c(shipPaid)) : null,
      shipNote: first ? shipNoteOf(o) : null,
      isFreeShip: first && o.ship_collected === 0 && o.requires_ss_rate ? 'YES' : '',
      isRoute: !!flags.isRoute, isGiftCard: !!flags.isGiftCard, isDigital: !!flags.isDigital, isSubRenewal: !!flags.isSubRenewal,
      isInfluencerSample: !!flags.isInfluencerSample, isProductLine: !!flags.isProductLine, subMonths: 1,
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
  const groups = new Map();
  for (const li of out) (groups.get(li.orderNum) || groups.set(li.orderNum, []).get(li.orderNum)).push(li);
  for (const g of groups.values()) {
    const delta = g[0].shipDelta ?? 0, tot = g.reduce((s, li) => s + (li.lineRevenue || 0), 0);
    for (const li of g) {
      const share = tot > 0 ? (li.lineRevenue || 0) / tot : 1 / g.length;
      li.lineNetGp = li.lineGp !== null ? Math.round((li.lineGp + Math.round(delta * share * 100) / 100) * 100) / 100 : null;
      li.lineNetGpPct = li.lineNetGp !== null && li.lineRevenue ? Math.round(li.lineNetGp / li.lineRevenue * 1000) / 10 : null;
    }
  }
  return out;
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
  const shipByVendor = { ShipStation: { paid: 0, orders: 0 }, 'HP Dropship': { paid: 0, orders: 0 }, 'Lively Root': { paid: 0, orders: 0 } };
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
      for (const [k, v] of [['ShipStation', c(o.ship_paid_ss)], ['HP Dropship', c(o.ship_paid_hp)], ['Lively Root', lr > 0 ? lr : 0]]) {
        shipByVendor[k].paid += v; if (v > 0) shipByVendor[k].orders++;
      }
    }
    for (const l of lines) {
      const f = P(l.flags, {}) || {};
      if (!f.isProductLine) continue;
      const missing = !!l.missing_cost, rev = c(l.contract_revenue), cogs = c(l.line_cogs);
      T.units += l.qty || 0;
      if (missing) { T.missing += rev; T.missingLines++; T.missingUnits += l.qty || 0; } else T.known += rev;
      const keys = { channel: f.isSubRenewal ? SUB_RENEWAL_CHANNEL : (l.channel || 'Unknown'), vendor: l.vendor_key || (w.skuVendors || {})[normalizeSku(l.sku)] || 'Unknown', store: l.store || 'Unknown' };
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
  const byStore = Object.fromEntries([...dims.store.values()].map(b => [b.key, { ...toS(b), orders: new Set(allLines.filter(l => (l.store || 'Unknown') === b.key).map(l => l.order_name)).size }]));
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
  const periodDays = daysBetween(plan.period.from, plan.period.to);
  const covered = plan.weeks.reduce((n, w) => n + daysBetween(w.days.from, w.days.to), 0);
  const complete = covered === periodDays;
  if (!complete) out.push({ kind: 'partial_period', tone: 'warn',
    text: `Partial ${plan.kind}: published weeks cover ${covered} of ${periodDays} days (${plan.weeks.map(w => fmtRange(w.days)).join(', ') || 'none'}). Figures are for those days only.` });
  for (const g of plan.gaps) out.push({ kind: g.reason, tone: 'warn', text: g.reason === 'before_reporting'
    ? `${fmtRange(g)} not included: GP is not reported before ${fmtDay(plan.earliest || PUBLICATION_EARLIEST)} (costs before then are not period-accurate).`
    : `${fmtRange(g)} not included: the week of ${fmtDay(g.weekStart)} has no published report${g.detail ? ` (${g.detail})` : ''}.` });
  if (plan.weeks.some(w => w.days.from !== w.weekStart || w.days.to !== addDays(w.weekStart, 6)))
    out.push({ kind: 'split_weeks', tone: 'info', text: `Weeks crossing the ${plan.kind} boundary are split by order date; only orders dated inside the ${plan.kind} count.` });
  if (totals.missingCostLines) out.push({ kind: 'missing_cost', tone: 'warn',
    text: `Product cost missing on ${totals.missingCostLines} line${totals.missingCostLines === 1 ? '' : 's'} (${money(totals.missingCostRevenue)} of revenue; ${totals.costCoverageByRevenue ?? '—'}% of product revenue has a cost). Operating GP includes that revenue but deducts no cost for it, so it is overstated by the missing costs. Product GP in the channel and vendor tables counts only lines with a known cost.` });
  const need = totals.ordersRequiringShipStationRate, have = totals.ordersWithValidShipStationRate;
  if (need && have < need) out.push({ kind: 'missing_shipping', tone: have / need < COVERAGE_THRESHOLD ? 'neg' : 'warn',
    text: `Shipping cost missing on ${need - have} of ${need} orders (${pct(have, need)}% covered). Their shipping expense is not in GP (not counted as $0), so GP after shipping is overstated.` });
  if (totals.hpdOrdersPassThrough) out.push({ kind: 'hpd_pass_through', tone: 'info',
    text: `HP Dropship shipping assumed equal to Shopify shipping collected on ${totals.hpdOrdersPassThrough} order${totals.hpdOrdersPassThrough === 1 ? '' : 's'} (pass-through; HPD actuals not received).` });
  for (const w of weekInfo) {
    const bits = [`week of ${fmtDay(w.weekStart)}: revision ${w.revision}`, w.verification === 'verified' ? 'independently verified' : `verification ${String(w.verification || 'pending').replace(/_/g, ' ')}`];
    if (w.catalog?.basis === 'cost_restatement') bits.push('costs corrected (audited cost correction)');
    if (w.catalog?.freshness?.status === 'reused_accepted') bits.push('pinned cost catalog accepted for this period');
    if (w.partialWeek) bits.push(`partial week (orders from ${w.partialWeek.from})`);
    if (w.flagsText) bits.push(w.flagsText);
    out.push({ kind: 'week', tone: 'info', text: bits.join(' · ') });
  }
  const provisional = !complete || totals.profitabilityStatus !== PROFITABILITY_STATUS.COMPLETE || weekInfo.some(w => w.verification !== 'verified');
  return { items: out, complete, covered, periodDays, provisional,
    headline: provisional ? 'Provisional operating GP after shipping' : 'Operating GP after shipping',
    status: !complete ? `Partial ${plan.kind}` : (provisional ? 'Provisional' : 'Complete') };
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
    const head = await client.snapshot(w.weekStart);
    const first = await client.reportPart(w.weekStart, 0, head.snapshotId);
    const parts = [first];
    const ks = Array.from({ length: Math.max(0, first.parts - 1) }, (_, i) => i + 1);
    for (let i = 0; i < ks.length; i += concurrency)
      parts.push(...await Promise.all(ks.slice(i, i + concurrency).map(k => client.reportPart(w.weekStart, k, head.snapshotId))));
    weeks.push({ weekStart: w.weekStart, snapshotId: head.snapshotId, revision: head.revision, head,
      orders: parts.flatMap(p => p.o?.orders || []), lines: parts.flatMap(p => p.l?.lines || []), skuVendors: first.skuVendors || {} });
  }
  return { plan, weeks };
}
