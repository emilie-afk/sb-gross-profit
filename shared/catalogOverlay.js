/**
 * catalogOverlay.js — C6d: the live Products Master tabs on top of a pinned base
 * ==============================================================================
 * Only five of build.py's sources can be refreshed live today: the public
 * Products Master vendor tabs (Live to Give, Lively Good = Lively Root,
 * Calathea Collective, Surfside Arrangement, LindaMakes). Every other table
 * (MCG, HPD, Air Plant Shop, weights, aliases, product-export supplements)
 * comes from a pinned BASE catalog: the existing cost files, registered once
 * and never modified.
 *
 * overlayVendorTabs() produces the combined catalog with build.py's own
 * semantics for exactly the tables the five tabs feed:
 *   vendor_costs, vendor_index   from the tabs (these come from nowhere else)
 *   product_costs                Live to Give costs set per SKU (build.py merges
 *                                l2g last); every other entry is untouched
 *   mcg_total                    only when lively_root_cost_source = 'sheet':
 *                                the Lively Root tab's listed costs; otherwise
 *                                untouched
 * assertBasePreserved() then proves no base entry outside those rules was
 * removed, zeroed or changed. catalogCompleteness() records which sources were
 * refreshed live and which still stand in from the pinned base, so the
 * product-cost disclosure stays "incomplete" until they are resolved.
 *
 * Pure: no network, no URLs. Callers pass sheet TEXT (catalogBuild.js).
 */
import { VENDOR_ORDER, VENDOR_ENV, LIVE_TO_GIVE, LIVELY_ROOT_MODES } from './catalogBuild.js';

/** The five live sources, by build.py environment name. */
export const OVERLAY_SOURCES = Object.freeze(VENDOR_ORDER.map(v => VENDOR_ENV[v]));
/** Tables a base may hold. Vendor tables never come from the base. */
export const BASE_TABLES = Object.freeze(['mcg_total', 'product_costs', 'sku_weights', 'sb_costs', 'hp_supplement', 'hp_by_name', 'sku_alias']);
const OVERLAY_TABLES = new Set(['vendor_costs', 'vendor_index']);

/** Which build.py sources a base table stands in for (for the completeness disclosure). */
export const BASE_SOURCE_MAP = Object.freeze({
  mcg_total:     ['MCG_SHEET_URL', 'MCG_POTS_SHEET_URL'],
  product_costs: ['HP_SHEET_URL', 'AS_SHEET_URL', 'PRODUCT_COSTS_JSON1', 'PRODUCT_COSTS_JSON2'],
  sku_weights:   ['HP_SHEET_URL', 'SKU_WEIGHTS_JSON'],
  sku_alias:     ['SB_SKU_ALIAS_URL', 'SB_SKU_ALIAS_URL_2', 'HP_SKU_ALIAS_URL'],
  sb_costs:      ['productExport'],
  hp_supplement: ['productExport'],
  hp_by_name:    ['productExport'],
  mcgExtra:      ['MCG_EXTRA_SHEET_URL'],
});
/** Every build.py source other than the five tabs. None is refreshed live in C6d. */
export const UNRESOLVED_SOURCES = Object.freeze(['MCG_SHEET_URL', 'MCG_POTS_SHEET_URL', 'SB_SKU_ALIAS_URL', 'SB_SKU_ALIAS_URL_2', 'HP_SKU_ALIAS_URL',
  'AS_SHEET_URL', 'HP_SHEET_URL', 'MCG_EXTRA_SHEET_URL', 'PRODUCT_COSTS_JSON1', 'PRODUCT_COSTS_JSON2', 'SKU_WEIGHTS_JSON', 'productExport']);

const count = t => (t && typeof t === 'object') ? Object.keys(t).length : 0;
const clone = v => JSON.parse(JSON.stringify(v ?? {}));

export class OverlayError extends Error { constructor(code, message) { super(message); this.code = code; } }

/**
 * A base must be the existing non-vendor cost tables: known table names only,
 * a non-empty mcg_total, and no vendor tables (those only come from the tabs).
 */
export function validateBaseCatalog(base) {
  const reasons = [];
  const tables = base?.tables;
  if (!tables || typeof tables !== 'object' || Array.isArray(tables)) return { accepted: false, reasons: ['tables must be an object'] };
  for (const k of Object.keys(tables)) {
    if (OVERLAY_TABLES.has(k)) reasons.push(`${k} must not be in a base catalog (it comes from the live tabs)`);
    else if (!BASE_TABLES.includes(k)) reasons.push(`unknown table ${String(k).slice(0, 40)}`);
  }
  for (const [k, t] of Object.entries(tables)) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) { reasons.push(`${k} must be an object`); continue; }
    if (k === 'mcg_total' || k === 'product_costs' || k === 'sb_costs' || k === 'hp_supplement' || k === 'hp_by_name' || k === 'sku_weights') {
      const bad = Object.values(t).filter(v => !(typeof v === 'number' && Number.isFinite(v))).length;
      if (bad) reasons.push(`${k}: ${bad} entr${bad === 1 ? 'y is' : 'ies are'} not a finite number`);
    }
  }
  if (!count(tables.mcg_total)) reasons.push('mcg_total is empty or missing');
  return { accepted: reasons.length === 0, reasons, counts: Object.fromEntries(BASE_TABLES.map(t => [t, count(tables[t])])) };
}

/**
 * @param {{ tables, mcgExtra?, overrides? }} base    pinned base catalog
 * @param {{ tables, report }} built                  buildCatalogTables() on the five tab texts
 * @param {{ livelyRootSource?: 'manual_list'|'sheet', livelyRootCosts?: Map }} opts
 */
export function overlayVendorTabs(base, built, { livelyRootSource = 'manual_list', livelyRootCosts = null } = {}) {
  if (!LIVELY_ROOT_MODES.includes(livelyRootSource)) throw new OverlayError('bad_mode', 'livelyRootSource must be manual_list or sheet');
  const v = validateBaseCatalog(base);
  if (!v.accepted) throw new OverlayError('base_invalid', v.reasons.join('; '));
  const tables = clone(base.tables);
  tables.vendor_costs = clone(built.tables.vendor_costs);
  tables.vendor_index = clone(built.tables.vendor_index);

  const report = { productCosts: { liveToGiveSkus: 0, added: 0, changed: 0, unchanged: 0 }, mcgTotal: { mode: livelyRootSource, added: 0, changed: 0, unchanged: 0 } };
  tables.product_costs = tables.product_costs || {};
  for (const [sku, e] of Object.entries(built.tables.vendor_costs?.[LIVE_TO_GIVE] || {})) {
    report.productCosts.liveToGiveSkus++;
    const old = tables.product_costs[sku];
    if (old === undefined) report.productCosts.added++;
    else if (old === e.unitCost) report.productCosts.unchanged++;
    else report.productCosts.changed++;
    tables.product_costs[sku] = e.unitCost;
  }
  if (livelyRootSource === 'sheet') {
    if (!(livelyRootCosts instanceof Map) || !livelyRootCosts.size) throw new OverlayError('lively_root_unavailable', 'Lively Root tab is the cost source but could not be read');
    for (const [sku, cost] of livelyRootCosts) {
      for (const k of new Set([sku, sku.toUpperCase()])) {
        const old = tables.mcg_total[k];
        if (old === undefined) report.mcgTotal.added++; else if (old === cost) report.mcgTotal.unchanged++; else report.mcgTotal.changed++;
        tables.mcg_total[k] = cost;
      }
    }
  }
  const candidate = { tables, mcgExtra: clone(base.mcgExtra), overrides: clone(base.overrides) };
  const violations = assertBasePreserved(base, candidate, { livelyRootSource, livelyRootCosts, built });
  if (violations.length) throw new OverlayError('base_not_preserved', `${violations.length} base entr${violations.length === 1 ? 'y was' : 'ies were'} changed outside the overlay rules`);
  return { candidate, report };
}

/**
 * Every base entry must survive unchanged, except the exact keys the overlay
 * rules may set (Live to Give SKUs in product_costs; Lively Root SKUs in
 * mcg_total in 'sheet' mode). Returns violations as { table, kind } (never keys).
 */
export function assertBasePreserved(base, candidate, { livelyRootSource = 'manual_list', livelyRootCosts = null, built } = {}) {
  const allowed = { product_costs: new Set(Object.keys(built?.tables?.vendor_costs?.[LIVE_TO_GIVE] || {})), mcg_total: new Set() };
  if (livelyRootSource === 'sheet' && livelyRootCosts instanceof Map) for (const k of livelyRootCosts.keys()) { allowed.mcg_total.add(k); allowed.mcg_total.add(k.toUpperCase()); }
  const out = [];
  for (const t of BASE_TABLES) {
    const b = base.tables?.[t] || {}, c = candidate.tables?.[t] || {};
    for (const [k, val] of Object.entries(b)) {
      if (allowed[t]?.has(k)) continue;
      if (!(k in c)) out.push({ table: t, kind: 'removed' });
      else if (JSON.stringify(c[k]) !== JSON.stringify(val)) out.push({ table: t, kind: (c[k] === 0 || c[k] === null) ? 'zeroed' : 'changed' });
    }
    for (const k of Object.keys(c)) if (!(k in b) && !allowed[t]?.has(k)) out.push({ table: t, kind: 'added' });
  }
  if (JSON.stringify(candidate.mcgExtra || {}) !== JSON.stringify(base.mcgExtra || {})) out.push({ table: 'mcgExtra', kind: 'changed' });
  if (JSON.stringify(candidate.overrides || {}) !== JSON.stringify(base.overrides || {})) out.push({ table: 'overrides', kind: 'changed' });
  return out;
}

/** The disclosure: live sources, sources still standing in from the base, and the label. */
export function catalogCompleteness({ baseCatalogRev, base, resolvedLive = OVERLAY_SOURCES }) {
  const carriedFromBase = Object.fromEntries(BASE_TABLES.map(t => [t, count(base?.tables?.[t])]));
  carriedFromBase.mcgExtra = count(base?.mcgExtra);
  const missingBaseTables = Object.entries(carriedFromBase).filter(([, n]) => n === 0).map(([t]) => t);
  const unresolved = [...UNRESOLVED_SOURCES];
  return {
    status: unresolved.length ? 'incomplete' : 'complete',
    kind: 'vendor_overlay',
    baseCatalogRev,
    resolvedLive: [...resolvedLive],
    unresolvedSources: unresolved,
    carriedFromBase,
    missingBaseTables,
    label: unresolved.length
      ? `Product-cost catalog incomplete: ${unresolved.length} cost sources are not refreshed live (pinned base ${baseCatalogRev})`
      : 'All cost sources refreshed live',
  };
}
