/**
 * read.js — /v1 read routes
 * =========================
 * Dashboard sessions see PUBLISHED snapshots only. Admin callers may add
 * ?includeDrafts=1 to review drafts and blocked revisions before go-live.
 * Nothing here returns raw source rows in bulk: order detail is paginated or
 * fetched one order at a time.
 */
import { ApiError, json, intParam, WEEK_RE } from './http.js';
import { totalsFromRow } from './compute.js';

const P = (s, d) => { try { return s === null || s === undefined ? d : JSON.parse(s); } catch { return d; } };

function statuses(url, reader) {
  const drafts = reader.admin && url.searchParams.get('includeDrafts') === '1';
  return drafts ? ['published', 'draft', 'blocked', 'superseded'] : ['published'];
}

async function pickSnapshot(db, weekStart, url, reader) {
  if (!WEEK_RE.test(weekStart)) throw new ApiError(400, 'bad_query', 'week must be YYYY-MM-DD');
  const allowed = statuses(url, reader);
  const rev = url.searchParams.get('revision');
  const q = rev
    ? db.prepare(`SELECT * FROM snapshot WHERE week_start = ?1 AND revision = ?2 AND status IN (SELECT value FROM json_each(?3))`).bind(weekStart, parseInt(rev, 10), JSON.stringify(allowed))
    : db.prepare(`SELECT * FROM snapshot WHERE week_start = ?1 AND status IN (SELECT value FROM json_each(?2))
        ORDER BY CASE status WHEN 'published' THEN 0 ELSE 1 END, revision DESC LIMIT 1`).bind(weekStart, JSON.stringify(allowed));
  const s = await q.first();
  if (!s) throw new ApiError(404, reader.admin ? 'week_unknown' : 'not_published', `No ${allowed.length > 1 ? '' : 'published '}snapshot for ${weekStart}`);
  return s;
}

/** Catalog selection as sessions see it: no acceptance reason or actor (admin audit only). */
function catalogView(s, reader) {
  const c = P(s.catalog_info, null);
  if (!c || reader?.admin) return c;
  const { acceptance, ...freshness } = c.freshness || {};
  return { rev: c.rev, capturedAt: c.capturedAt, basis: c.basis, freshness: { status: freshness.status } };
}

const header = (s, reader = null) => ({ weekStart: s.week_start, revision: s.revision, status: s.status, snapshotId: s.snapshot_id,
  computedAt: s.computed_at, publishedAt: s.published_at, engineVersion: s.engine_version, catalogRev: s.catalog_rev,
  catalog: catalogView(s, reader), policy: P(s.policy, {}), profitabilityStatus: s.profitability_status });

export async function listWeeks(request, env, reader) {
  const url = new URL(request.url);
  const allowed = statuses(url, reader);
  const rows = (await env.DB.prepare(`SELECT s.week_start, s.revision, s.status, s.profitability_status, s.computed_at,
      t.operating_revenue, t.operating_gp_after_shipping, t.operating_gp_margin
    FROM snapshot s JOIN snapshot_totals t ON t.snapshot_id = s.snapshot_id
    WHERE s.status IN (SELECT value FROM json_each(?1)) ORDER BY s.week_start DESC, s.revision DESC`).bind(JSON.stringify(allowed)).all()).results || [];
  const weeks = new Map();
  for (const r of rows) {
    if (!weeks.has(r.week_start)) weeks.set(r.week_start, { weekStart: r.week_start, revisions: [] });
    weeks.get(r.week_start).revisions.push({ revision: r.revision, status: r.status, profitabilityStatus: r.profitability_status,
      computedAt: r.computed_at, operatingRevenue: r.operating_revenue, operatingGpAfterShipping: r.operating_gp_after_shipping,
      operatingGpMargin: r.operating_gp_margin });
  }
  return json({ weeks: [...weeks.values()] });
}

export async function getSnapshot(request, env, reader, weekStart) {
  const url = new URL(request.url);
  const s = await pickSnapshot(env.DB, weekStart, url, reader);
  const t = await env.DB.prepare('SELECT * FROM snapshot_totals WHERE snapshot_id = ?1').bind(s.snapshot_id).first();
  const top = intParam(url, 'breakdownLimit', 50, { min: 1, max: 500 });
  const bd = (await env.DB.prepare('SELECT * FROM snapshot_breakdown WHERE snapshot_id = ?1 ORDER BY dimension, known_cost_revenue DESC').bind(s.snapshot_id).all()).results || [];
  const breakdowns = {};
  for (const b of bd) {
    (breakdowns[b.dimension] ||= []);
    if (breakdowns[b.dimension].length >= top) continue;
    breakdowns[b.dimension].push({ key: b.key, units: b.units, knownCostRevenue: b.known_cost_revenue, knownCogs: b.known_cogs,
      knownCostGp: b.known_cost_gp, knownCostMargin: b.known_cost_margin, missingCostRevenue: b.missing_cost_revenue,
      missingCostUnits: b.missing_cost_units, missingCostLines: b.missing_cost_lines, coverageStatus: b.coverage_status,
      gpLabel: b.missing_cost_lines ? 'Known-cost product GP' : 'Product GP',
      ...(b.detail ? P(b.detail, {}) : {}) });
  }
  const recon = ((await env.DB.prepare('SELECT * FROM snapshot_reconciliation WHERE snapshot_id = ?1 ORDER BY check_name').bind(s.snapshot_id).all()).results || [])
    .map(r => ({ check: r.check_name, expected: r.expected, actual: r.actual, delta: r.delta, passed: !!r.passed, blocking: !!r.blocking }));
  const issueCounts = Object.fromEntries(((await env.DB.prepare('SELECT kind, COUNT(*) AS n FROM snapshot_issue WHERE snapshot_id = ?1 GROUP BY kind')
    .bind(s.snapshot_id).all()).results || []).map(r => [r.kind, r.n]));
  const narrative = P((await env.DB.prepare('SELECT narrative FROM snapshot_narrative WHERE snapshot_id = ?1').bind(s.snapshot_id).first())?.narrative, null);
  // The narrative's comparison is always against the prior PUBLISHED week. A
  // draft-basis comparison is an admin preview, returned only with includeDrafts.
  const preview = reader.admin && url.searchParams.get('includeDrafts') === '1' ? P(s.draft_comparison, null) : undefined;
  return json({ ...header(s, reader), totals: totalsFromRow(t), passThrough: { routeCollected: t.route_collected, routeRemitted: t.route_remitted, routeNet: t.route_net },
    revenueBridge: P(t.revenue_bridge, null), breakdowns, reconciliation: recon, issueCounts, narrative,
    ...(preview !== undefined ? { draftComparisonPreview: preview } : {}) });
}

const ORDER_SORTS = {
  gp_asc: 'operating_gp ASC', gp_desc: 'operating_gp DESC', revenue_desc: 'operating_revenue DESC',
  date_desc: 'business_date DESC, order_name DESC', date_asc: 'business_date ASC, order_name ASC',
};

export async function listOrders(request, env, reader, weekStart) {
  const url = new URL(request.url);
  const s = await pickSnapshot(env.DB, weekStart, url, reader);
  const limit = intParam(url, 'limit', 50, { min: 1, max: 500 });
  const offset = intParam(url, 'offset', 0, { min: 0 });
  const sort = url.searchParams.get('sort') || 'gp_asc';
  if (!ORDER_SORTS[sort]) throw new ApiError(400, 'bad_query', `sort must be one of ${Object.keys(ORDER_SORTS).join(', ')}`);
  const where = ['snapshot_id = ?1']; const vals = [s.snapshot_id];
  const add = (cond, v) => { vals.push(v); where.push(cond.replace('?', `?${vals.length}`)); };
  if (url.searchParams.get('missingCost') === 'true') where.push('missing_cost_lines > 0');
  if (url.searchParams.get('missingShipping') === 'true') where.push("shipping_expense_status = 'missing_shipstation_rate'");
  if (url.searchParams.get('channel')) add('channel = ?', url.searchParams.get('channel'));
  if (url.searchParams.get('category')) add('order_cat = ?', url.searchParams.get('category'));
  if (url.searchParams.get('status')) add('profitability_status = ?', url.searchParams.get('status'));
  const whereSql = where.join(' AND ');
  const total = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM snapshot_order WHERE ${whereSql}`).bind(...vals).first())?.n || 0;
  const rows = (await env.DB.prepare(`SELECT * FROM snapshot_order WHERE ${whereSql} ORDER BY ${ORDER_SORTS[sort]} LIMIT ${limit} OFFSET ${offset}`)
    .bind(...vals).all()).results || [];
  return json({ ...header(s, reader), page: { offset, limit, total }, sort, orders: rows.map(orderOut) });
}

const orderOut = o => ({ orderName: o.order_name, businessDate: o.business_date, channel: o.channel, orderCat: o.order_cat,
  operatingRevenue: o.operating_revenue, shopifyNetRevenue: o.shopify_net_revenue, routeCollected: o.route_collected,
  knownProductCogs: o.known_product_cogs, shipCollected: o.ship_collected, shipPaid: o.ship_paid, shipPaidSS: o.ship_paid_ss,
  shipPaidHP: o.ship_paid_hp, operatingGp: o.operating_gp, missingCostLines: o.missing_cost_lines,
  requiresShipStationRate: o.requires_ss_rate === null ? null : !!o.requires_ss_rate,
  hasValidShipStationRate: o.has_valid_ss_rate === null ? null : !!o.has_valid_ss_rate,
  shippingExpenseSource: o.shipping_expense_source, shippingExpenseStatus: o.shipping_expense_status,
  missingReason: o.missing_reason, profitabilityStatus: o.profitability_status, hpdShippingBasis: o.hpd_shipping_basis, lineCount: o.line_count });

const lineOut = l => ({ lineIndex: l.line_index, sku: l.sku, product: l.product, vendorKey: l.vendor_key, channel: l.channel,
  store: l.store, qty: l.qty, unitPrice: l.unit_price, unitCost: l.unit_cost, contractRevenue: l.contract_revenue,
  lineCogs: l.line_cogs, knownCostGp: l.known_cost_gp, costSource: l.cost_source, costMatchType: l.cost_match_type,
  missingCost: !!l.missing_cost, discountAllocated: l.discount_allocated, discountSource: l.discount_source,
  refundAllocated: l.refund_allocated, refundSource: l.refund_source, routeCollected: l.route_collected,
  routeRemitted: l.route_remitted, flags: P(l.flags, {}) });

export async function getOrder(request, env, reader, weekStart, orderName) {
  const url = new URL(request.url);
  const s = await pickSnapshot(env.DB, weekStart, url, reader);
  const o = await env.DB.prepare('SELECT * FROM snapshot_order WHERE snapshot_id = ?1 AND order_name = ?2').bind(s.snapshot_id, orderName).first();
  if (!o) throw new ApiError(404, 'order_unknown', `No order ${orderName} in this snapshot`);
  const lines = (await env.DB.prepare('SELECT * FROM snapshot_line WHERE snapshot_id = ?1 AND order_name = ?2 ORDER BY line_index')
    .bind(s.snapshot_id, orderName).all()).results || [];
  return json({ ...header(s, reader), order: orderOut(o), lines: lines.map(lineOut) });
}

export async function listIssues(request, env, reader, weekStart) {
  const url = new URL(request.url);
  const s = await pickSnapshot(env.DB, weekStart, url, reader);
  const limit = intParam(url, 'limit', 100, { min: 1, max: 1000 });
  const offset = intParam(url, 'offset', 0, { min: 0 });
  const kind = url.searchParams.get('kind');
  const vals = [s.snapshot_id]; let where = 'snapshot_id = ?1';
  if (kind) { vals.push(kind); where += ' AND kind = ?2'; }
  const total = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM snapshot_issue WHERE ${where}`).bind(...vals).first())?.n || 0;
  const rows = (await env.DB.prepare(`SELECT * FROM snapshot_issue WHERE ${where} ORDER BY seq LIMIT ${limit} OFFSET ${offset}`).bind(...vals).all()).results || [];
  return json({ ...header(s, reader), page: { offset, limit, total }, issues: rows.map(r => ({ kind: r.kind, orderName: r.order_name, ...P(r.detail, {}) })) });
}

/**
 * Compact line set for the browser's scenario calculator. Product lines and
 * Route only, with just the fields scenario.js reads. Order-level shipping sits
 * on each order's first line, as the engine delivers it.
 */
export async function scenarioInput(request, env, reader, weekStart) {
  const url = new URL(request.url);
  const s = await pickSnapshot(env.DB, weekStart, url, reader);
  const orders = new Map(((await env.DB.prepare('SELECT order_name, ship_collected, ship_paid, business_date FROM snapshot_order WHERE snapshot_id = ?1')
    .bind(s.snapshot_id).all()).results || []).map(o => [o.order_name, o]));
  const lines = (await env.DB.prepare('SELECT * FROM snapshot_line WHERE snapshot_id = ?1 ORDER BY order_name, line_index').bind(s.snapshot_id).all()).results || [];
  const seen = new Set();
  const out = [];
  for (const l of lines) {
    const flags = P(l.flags, {});
    if (!flags.isProductLine && !flags.isRoute) continue;
    const o = orders.get(l.order_name) || {};
    const first = !seen.has(l.order_name); seen.add(l.order_name);
    const revenue = flags.isRoute ? l.route_collected : l.contract_revenue;
    out.push({ orderNum: l.order_name, date: o.business_date, sku: l.sku, product: l.product, vendor: l.vendor_key,
      vendorKey: l.vendor_key, qty: l.qty, unitPrice: l.unit_price, baseMerchRevenue: Math.round((l.unit_price || 0) * (l.qty || 0) * 100) / 100,
      lineRevenue: revenue, lineCogs: l.line_cogs, missingCost: !!l.missing_cost, costSource: l.cost_source,
      isRoute: !!flags.isRoute, isGiftCard: !!flags.isGiftCard, isInfluencerSample: !!flags.isInfluencerSample,
      shipCollected: first ? o.ship_collected : null, shipPaid: first ? o.ship_paid : null });
  }
  return json({ ...header(s, reader), lines: out });
}

export async function history(request, env, reader) {
  const url = new URL(request.url);
  const from = url.searchParams.get('from') || '0000-01-01', to = url.searchParams.get('to') || '9999-12-31';
  if (!WEEK_RE.test(from) || !WEEK_RE.test(to)) throw new ApiError(400, 'bad_query', 'from and to must be YYYY-MM-DD');
  const allowed = statuses(url, reader).filter(x => x !== 'superseded');
  const rows = (await env.DB.prepare(`SELECT s.week_start, s.revision, s.status, t.* FROM snapshot s JOIN snapshot_totals t ON t.snapshot_id = s.snapshot_id
    WHERE s.week_start >= ?1 AND s.week_start <= ?2 AND s.status IN (SELECT value FROM json_each(?3))
    ORDER BY s.week_start, CASE s.status WHEN 'published' THEN 0 ELSE 1 END, s.revision DESC`).bind(from, to, JSON.stringify(allowed)).all()).results || [];
  const byWeek = new Map();
  for (const r of rows) if (!byWeek.has(r.week_start)) byWeek.set(r.week_start, { weekStart: r.week_start, revision: r.revision, status: r.status, totals: totalsFromRow(r) });
  return json({ from, to, definition: 'operating', weeks: [...byWeek.values()] });
}

export async function compare(request, env, reader) {
  const url = new URL(request.url);
  const a = url.searchParams.get('from'), b = url.searchParams.get('to');
  if (!WEEK_RE.test(a || '') || !WEEK_RE.test(b || '')) throw new ApiError(400, 'bad_query', 'from and to must be YYYY-MM-DD week starts');
  const [sa, sb] = [await pickSnapshot(env.DB, a, url, reader), await pickSnapshot(env.DB, b, url, reader)];
  const [ta, tb] = await Promise.all([sa, sb].map(async s => totalsFromRow(await env.DB.prepare('SELECT * FROM snapshot_totals WHERE snapshot_id = ?1').bind(s.snapshot_id).first())));
  const keys = ['operatingRevenue', 'operatingGpAfterShipping', 'knownCostProductRevenue', 'knownCostProductGp', 'shippingExpense',
                'shippingCollected', 'routeCollected', 'missingCostRevenue'];
  const delta = Object.fromEntries(keys.map(k => [k, Math.round(((tb[k] || 0) - (ta[k] || 0)) * 100) / 100]));
  const provisional = ta.profitabilityStatus !== 'complete' || tb.profitabilityStatus !== 'complete';
  return json({ definition: 'operating', from: { ...header(sa, reader), totals: ta }, to: { ...header(sb, reader), totals: tb }, delta,
    comparable: sa.engine_version === sb.engine_version, provisional,
    note: provisional ? 'Provisional comparison: at least one week has incomplete cost or shipping coverage.' : null });
}
