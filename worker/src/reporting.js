/**
 * reporting.js — GET /v1/reporting/weeks (X-Reporting-Secret only)
 * ==================================================================
 * Read-only weekly gross-profit totals for the Marketing Dashboard's server. One record per PUBLISHED week:
 * drafts, blocked, provisional and superseded revisions are never returned, so a figure reaches the dashboard
 * only after it passed this app's own publication controls. A later published revision of the same week replaces
 * the earlier one under the same record id with a higher revision number.
 *
 * Returned per week: stable ids, the reporting dates and timezone, the scope (the Shopify store), completeness,
 * revision and publication times, and store-level totals. Never returned: orders, order lines, SKUs, customers,
 * catalog or policy detail, verification reports, publication holds, actors, notes or any secret.
 *
 * Paginated in week order with an opaque cursor (the last week returned). D1 cost: at most limit + 1 rows.
 */
import { ApiError, json, intParam, WEEK_RE } from './http.js';
import { getSettings } from './db.js';
import { DEFAULT_REPORTING_TIMEZONE } from '../../shared/schedule.js';
import { PROFITABILITY_STATUS } from '../../shared/metrics.js';

export const REPORTING_PAGE_MAX = 52;
export const REPORTING_SCHEMA_VERSION = 1;

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const P = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const num = v => (v === null || v === undefined ? null : Number(v));

/** complete | provisional | partial, with the plain reasons. A partial week (store start mid-week) is partial. */
export function completenessOf(profitabilityStatus, partialWeek) {
  const reasons = [];
  if (profitabilityStatus === PROFITABILITY_STATUS.PROVISIONAL_MISSING_COSTS || profitabilityStatus === PROFITABILITY_STATUS.PROVISIONAL_MISSING_COSTS_AND_SHIPPING) reasons.push('missing_product_costs');
  if (profitabilityStatus === PROFITABILITY_STATUS.PROVISIONAL_MISSING_SHIPPING || profitabilityStatus === PROFITABILITY_STATUS.PROVISIONAL_MISSING_COSTS_AND_SHIPPING) reasons.push('missing_shipping_costs');
  if (profitabilityStatus === PROFITABILITY_STATUS.PROVISIONAL_HPD_PASS_THROUGH) reasons.push('assumed_dropship_shipping');
  if (profitabilityStatus && !Object.values(PROFITABILITY_STATUS).includes(profitabilityStatus)) reasons.push('unknown_status');
  if (partialWeek) reasons.push('partial_week');
  const completeness = partialWeek ? 'partial' : reasons.length ? 'provisional' : 'complete';
  return { completeness, reasons };
}

export async function reportingWeeks(request, env) {
  const url = new URL(request.url);
  for (const k of url.searchParams.keys()) if (!['from', 'to', 'cursor', 'limit'].includes(k)) throw new ApiError(400, 'bad_query', `Unknown parameter ${k}`);
  const from = url.searchParams.get('from') || '0000-01-01';
  const to = url.searchParams.get('to') || '9999-12-31';
  const cursor = url.searchParams.get('cursor');
  if (!WEEK_RE.test(from) || !WEEK_RE.test(to) || (cursor !== null && !WEEK_RE.test(cursor))) throw new ApiError(400, 'bad_query', 'from, to and cursor must be YYYY-MM-DD');
  if (from > to) throw new ApiError(400, 'bad_query', 'from must not be after to');
  const limit = intParam(url, 'limit', 26, { min: 1, max: REPORTING_PAGE_MAX });

  const rows = (await env.DB.prepare(`SELECT s.snapshot_id, s.week_start, s.revision, s.computed_at, s.published_at, s.profitability_status,
      t.operating_revenue, t.operating_gp_after_shipping, t.known_product_cogs, t.shipping_expense,
      t.known_cost_product_revenue, t.missing_cost_revenue, t.missing_cost_lines, t.cost_coverage_by_revenue,
      t.orders_requiring_shipstation_rate, t.orders_with_valid_shipstation_rate, json_extract(t.labels, '$.partialWeek') AS partial_week
    FROM snapshot s JOIN snapshot_totals t ON t.snapshot_id = s.snapshot_id
    WHERE s.status = 'published' AND s.week_start >= ?1 AND s.week_start <= ?2 AND (?3 IS NULL OR s.week_start > ?3)
    ORDER BY s.week_start LIMIT ?4`).bind(from, to, cursor, limit + 1).all()).results || [];

  const page = rows.slice(0, limit);
  const settings = await getSettings(env.DB);
  const timezone = settings.store_timezone || DEFAULT_REPORTING_TIMEZONE;
  const weeks = page.map(r => {
    const partialWeek = P(r.partial_week);
    const { completeness, reasons } = completenessOf(r.profitability_status, partialWeek);
    return {
      id: `gp:week:${r.week_start}`,                 // stable per week; a new published revision keeps it
      snapshot_id: r.snapshot_id,                    // this exact revision
      revision: r.revision,
      period: { start: partialWeek?.reportingStart || r.week_start, end: addDays(r.week_start, 6), week_start: r.week_start, granularity: partialWeek ? 'custom' : 'week', timezone },
      scope: { key: 'shopify_store', label: 'Shopify store (all Shopify sales channels; Route protection excluded)' },
      completeness, completeness_reasons: reasons,
      computed_at: r.computed_at, published_at: r.published_at,
      currency: 'USD',
      totals: {
        gross_profit: num(r.operating_gp_after_shipping),            // operating GP after shipping
        gross_profit_revenue_basis: num(r.operating_revenue),        // the revenue that profit was calculated on
        product_cost: num(r.known_product_cogs),                     // known product costs only; see missing_cost_*
        shipping_cost: num(r.shipping_expense),
        known_cost_product_revenue: num(r.known_cost_product_revenue),
        missing_cost_revenue: num(r.missing_cost_revenue),
        missing_cost_lines: num(r.missing_cost_lines),
        cost_coverage_by_revenue_pct: num(r.cost_coverage_by_revenue),
        orders_requiring_shipping_cost: num(r.orders_requiring_shipstation_rate),
        orders_with_shipping_cost: num(r.orders_with_valid_shipstation_rate),
      },
    };
  });
  return json({
    ok: true, schema_version: REPORTING_SCHEMA_VERSION, source: 'sb-gross-profit', status_filter: 'published',
    weeks, next_cursor: rows.length > limit ? page[page.length - 1].week_start : null,
  }, 200, { 'Cache-Control': 'no-store' });
}
