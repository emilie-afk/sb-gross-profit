/**
 * read.js — /v1 read routes
 * =========================
 * Dashboard sessions see PUBLISHED snapshots only. Admin callers may add
 * ?includeDrafts=1 to review drafts and blocked revisions before go-live.
 * Nothing here returns raw source rows in bulk: order detail is paginated or
 * fetched one order at a time.
 */
import { ApiError, json, jsonText, intParam, WEEK_RE } from './http.js';
import { totalsFromRow } from './compute.js';
import { gunzipCapped, blobBytes } from './gz.js';
import { verificationOf } from './verifyRoutes.js';
import { scenarioLines, indexRow } from '../../shared/resultParts.js';

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
  return withVerification(db, s, reader);
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
  catalog: catalogView(s, reader), policy: P(s.policy, {}), profitabilityStatus: s.profitability_status,
  ...(s.storage === 'chunked' ? { computedBy: 'collector', verification: s._verification || { status: 'pending' } } : {}) });

// ─── Free-tier (collector-computed) snapshots: the same rows, read from gzip parts ──

const PART_CAP = 8 * 1024 * 1024;
async function part(db, s, name) {
  const r = await db.prepare('SELECT body FROM snapshot_blob WHERE snapshot_id = ?1 AND part = ?2').bind(s.snapshot_id, name).first();
  if (!r) throw new ApiError(500, 'snapshot_part_missing', 'A stored part of this snapshot is missing');
  return JSON.parse(await gunzipCapped(blobBytes(r.body), PART_CAP));
}
/** Several parts in one query → Map name → gunzipped text. */
async function partTexts(db, s, names) {
  if (!names.length) return new Map();
  const rows = (await db.prepare('SELECT part, body FROM snapshot_blob WHERE snapshot_id = ?1 AND part IN (SELECT value FROM json_each(?2))').bind(s.snapshot_id, JSON.stringify(names)).all()).results || [];
  if (rows.length !== names.length) throw new ApiError(500, 'snapshot_part_missing', 'A stored part of this snapshot is missing');
  const out = new Map();
  for (const r of rows) out.set(r.part, await gunzipCapped(blobBytes(r.body), PART_CAP));
  return out;
}
/** The order index: one tuple per order (engine order) with list fields and the part k holding the order. */
const orderIndex = async (db, s) => (await part(db, s, 'orderindex')).orders.map(indexRow);
/** SQLite ORDER BY semantics for one key: NULLs first ascending, last descending; numbers numerically, text binary. */
const sqlCmp = (key, desc = false) => (a, b) => {
  const x = a[key], y = b[key];
  if (x === y) return 0;
  if (x === null || x === undefined) return desc ? 1 : -1;
  if (y === null || y === undefined) return desc ? -1 : 1;
  const c = typeof x === 'number' && typeof y === 'number' ? x - y : (String(x) < String(y) ? -1 : 1);
  return desc ? -c : c;
};
const chain = (...fs) => (a, b) => { for (const f of fs) { const c = f(a, b); if (c) return c; } return 0; };
async function withVerification(db, s, reader) {
  if (s.storage !== 'chunked') return s;
  const v = (await verificationOf(db, [s.snapshot_id], { admin: true })).get(s.snapshot_id);
  return { ...s, _verification: v ? { status: v.status, at: v.at, attempts: v.attempts, counts: v.report, ...(v.diff ? { differences: v.diff } : {}) } : { status: 'pending' } };
}

export async function listWeeks(request, env, reader) {
  const url = new URL(request.url);
  const allowed = statuses(url, reader);
  const rows = (await env.DB.prepare(`SELECT s.week_start, s.revision, s.status, s.profitability_status, s.computed_at, s.storage, v.status AS verification,
      t.operating_revenue, t.operating_gp_after_shipping, t.operating_gp_margin
    FROM snapshot s JOIN snapshot_totals t ON t.snapshot_id = s.snapshot_id LEFT JOIN verify_report v ON v.snapshot_id = s.snapshot_id
    WHERE s.status IN (SELECT value FROM json_each(?1)) ORDER BY s.week_start DESC, s.revision DESC`).bind(JSON.stringify(allowed)).all()).results || [];
  const weeks = new Map();
  for (const r of rows) {
    if (!weeks.has(r.week_start)) weeks.set(r.week_start, { weekStart: r.week_start, revisions: [] });
    weeks.get(r.week_start).revisions.push({ revision: r.revision, status: r.status, profitabilityStatus: r.profitability_status,
      computedAt: r.computed_at, operatingRevenue: r.operating_revenue, operatingGpAfterShipping: r.operating_gp_after_shipping,
      operatingGpMargin: r.operating_gp_margin,
      ...(r.storage === 'chunked' ? { computedBy: 'collector', verification: r.verification || 'pending' } : {}) });
  }
  return json({ weeks: [...weeks.values()] });
}

export async function getSnapshot(request, env, reader, weekStart) {
  const url = new URL(request.url);
  const s = await pickSnapshot(env.DB, weekStart, url, reader);
  const t = await env.DB.prepare('SELECT * FROM snapshot_totals WHERE snapshot_id = ?1').bind(s.snapshot_id).first();
  const top = intParam(url, 'breakdownLimit', 50, { min: 1, max: 500 });
  const sections = s.storage === 'chunked' ? await part(env.DB, s, 'sections') : null;
  const bd = sections ? [...sections.breakdowns].sort(chain(sqlCmp('dimension'), sqlCmp('known_cost_revenue', true), sqlCmp('key')))
    : (await env.DB.prepare('SELECT * FROM snapshot_breakdown WHERE snapshot_id = ?1 ORDER BY dimension, known_cost_revenue DESC, key').bind(s.snapshot_id).all()).results || [];
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
  const recon = (sections ? [...sections.reconciliation].sort(sqlCmp('check_name'))
    : (await env.DB.prepare('SELECT * FROM snapshot_reconciliation WHERE snapshot_id = ?1 ORDER BY check_name').bind(s.snapshot_id).all()).results || [])
    .map(r => ({ check: r.check_name, expected: r.expected, actual: r.actual, delta: r.delta, passed: !!r.passed, blocking: !!r.blocking }));
  const issueCounts = sections ? Object.fromEntries(Object.entries(sections.issues.reduce((m, r) => (m[r.kind] = (m[r.kind] || 0) + 1, m), {})).sort((a, b) => (a[0] < b[0] ? -1 : 1)))
    : Object.fromEntries(((await env.DB.prepare('SELECT kind, COUNT(*) AS n FROM snapshot_issue WHERE snapshot_id = ?1 GROUP BY kind')
      .bind(s.snapshot_id).all()).results || []).map(r => [r.kind, r.n]));
  const narrative = P((await env.DB.prepare('SELECT narrative FROM snapshot_narrative WHERE snapshot_id = ?1').bind(s.snapshot_id).first())?.narrative, null);
  // The narrative's comparison is always against the prior PUBLISHED week. A
  // draft-basis comparison is an admin preview, returned only with includeDrafts.
  const preview = reader.admin && url.searchParams.get('includeDrafts') === '1' ? P(s.draft_comparison, null) : undefined;
  return json({ ...header(s, reader), totals: totalsFromRow(t), passThrough: { routeCollected: t.route_collected, routeRemitted: t.route_remitted, routeNet: t.route_net },
    revenueBridge: P(t.revenue_bridge, null), breakdowns, reconciliation: recon, issueCounts, narrative,
    ...(preview !== undefined ? { draftComparisonPreview: preview } : {}) });
}

// A final order_name key makes every sort total (identical in SQL and for chunked snapshots).
const ORDER_SORTS = {
  gp_asc: 'operating_gp ASC, order_name ASC', gp_desc: 'operating_gp DESC, order_name ASC', revenue_desc: 'operating_revenue DESC, order_name ASC',
  date_desc: 'business_date DESC, order_name DESC', date_asc: 'business_date ASC, order_name ASC',
};
const ORDER_SORT_FNS = {
  gp_asc: chain(sqlCmp('operating_gp'), sqlCmp('order_name')), gp_desc: chain(sqlCmp('operating_gp', true), sqlCmp('order_name')),
  revenue_desc: chain(sqlCmp('operating_revenue', true), sqlCmp('order_name')),
  date_desc: chain(sqlCmp('business_date', true), sqlCmp('order_name', true)), date_asc: chain(sqlCmp('business_date'), sqlCmp('order_name')),
};

export async function listOrders(request, env, reader, weekStart) {
  const url = new URL(request.url);
  const s = await pickSnapshot(env.DB, weekStart, url, reader);
  const limit = intParam(url, 'limit', 50, { min: 1, max: 500 });
  const offset = intParam(url, 'offset', 0, { min: 0 });
  const sort = url.searchParams.get('sort') || 'gp_asc';
  if (!ORDER_SORTS[sort]) throw new ApiError(400, 'bad_query', `sort must be one of ${Object.keys(ORDER_SORTS).join(', ')}`);
  if (s.storage === 'chunked') {
    // Filter and sort on the compact index; read only the parts that hold the page's orders
    // (parts group orders in gp_asc order, so the default sort touches one or two parts).
    const q = url.searchParams;
    const idx = (await orderIndex(env.DB, s)).filter(o =>
      (q.get('missingCost') !== 'true' || o.missing_cost_lines > 0) &&
      (q.get('missingShipping') !== 'true' || o.shipping_expense_status === 'missing_shipstation_rate') &&
      (!q.get('channel') || o.channel === q.get('channel')) && (!q.get('category') || o.order_cat === q.get('category')) &&
      (!q.get('status') || o.profitability_status === q.get('status'))).sort(ORDER_SORT_FNS[sort]);
    const page = idx.slice(offset, offset + limit);
    const texts = await partTexts(env.DB, s, [...new Set(page.map(o => `orders:${o.part}`))]);
    const rows = new Map();
    for (const t of texts.values()) for (const o of JSON.parse(t).orders) rows.set(o.order_name, o);
    return json({ ...header(s, reader), page: { offset, limit, total: idx.length }, sort, orders: page.map(o => orderOut(rows.get(o.order_name))) });
  }
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
  let o, lines;
  if (s.storage === 'chunked') {
    const hit = (await orderIndex(env.DB, s)).find(x => x.order_name === orderName);
    if (hit) {
      const texts = await partTexts(env.DB, s, [`orders:${hit.part}`, `lines:${hit.part}`]);
      o = JSON.parse(texts.get(`orders:${hit.part}`)).orders.find(x => x.order_name === orderName);
      lines = JSON.parse(texts.get(`lines:${hit.part}`)).lines.filter(l => l.order_name === orderName).sort(sqlCmp('line_index'));
    }
  } else {
    o = await env.DB.prepare('SELECT * FROM snapshot_order WHERE snapshot_id = ?1 AND order_name = ?2').bind(s.snapshot_id, orderName).first();
    lines = (await env.DB.prepare('SELECT * FROM snapshot_line WHERE snapshot_id = ?1 AND order_name = ?2 ORDER BY line_index')
      .bind(s.snapshot_id, orderName).all()).results || [];
  }
  if (!o) throw new ApiError(404, 'order_unknown', `No order ${orderName} in this snapshot`);
  return json({ ...header(s, reader), order: orderOut(o), lines: lines.map(lineOut) });
}

export async function listIssues(request, env, reader, weekStart) {
  const url = new URL(request.url);
  const s = await pickSnapshot(env.DB, weekStart, url, reader);
  const limit = intParam(url, 'limit', 100, { min: 1, max: 1000 });
  const offset = intParam(url, 'offset', 0, { min: 0 });
  const kind = url.searchParams.get('kind');
  if (s.storage === 'chunked') {
    const rows = (await part(env.DB, s, 'sections')).issues.filter(r => !kind || r.kind === kind).sort(sqlCmp('seq'));
    return json({ ...header(s, reader), page: { offset, limit, total: rows.length }, issues: rows.slice(offset, offset + limit).map(r => ({ kind: r.kind, orderName: r.order_name, ...P(r.detail, {}) })) });
  }
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
  if (s.storage === 'chunked') {
    // The scenario parts' texts are canonical `{"lines":[…]}`: their arrays are joined as text, not parsed and re-serialized.
    const names = ((await env.DB.prepare("SELECT part FROM snapshot_blob WHERE snapshot_id = ?1 AND part LIKE 'scenario:%'").bind(s.snapshot_id).all()).results || [])
      .map(r => r.part).sort((a, b) => Number(a.slice(9)) - Number(b.slice(9)));
    const texts = await partTexts(env.DB, s, names);
    const inner = names.map(n => { const t = texts.get(n); if (!t.startsWith('{"lines":[') || !t.endsWith(']}')) throw new ApiError(500, 'snapshot_part_invalid', 'A stored scenario part is not canonical'); return t.slice(10, -2); }).filter(Boolean);
    const head = JSON.stringify(header(s, reader));
    return jsonText(`${head.slice(0, -1)}${head.length > 2 ? ',' : ''}"lines":[${inner.join(',')}]}`);
  }
  const orders = (await env.DB.prepare('SELECT order_name, ship_collected, ship_paid, business_date FROM snapshot_order WHERE snapshot_id = ?1')
    .bind(s.snapshot_id).all()).results || [];
  const lines = (await env.DB.prepare('SELECT * FROM snapshot_line WHERE snapshot_id = ?1 ORDER BY order_name, line_index').bind(s.snapshot_id).all()).results || [];
  const out = scenarioLines(orders, lines);                        // shared with the Free-tier result parts
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
