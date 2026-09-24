/**
 * catalog.js — cost-catalog shape, validation and versioning rules
 * ================================================================
 * The generated cost tables are deployment data (gitignored `data/`). The
 * pipeline imports and versions them rather than expecting them in Git:
 *
 *   build.py (Netlify build, same sheets and parsing as the dashboard)
 *     └─ optional push step → POST /v1/ingest/catalog → validateCatalog() → cost_catalog row
 *
 * Tables (the twelve cost sources behind calculate()):
 *   mcg_total, product_costs, sku_weights, sb_costs, hp_supplement, hp_by_name,
 *   sku_alias, vendor_costs (five vendors), vendor_index, plus mcgExtra
 *   (MCG_EXTRA_SHEET_URL, served to the dashboard by the edge function) and
 *   optional manual overrides (the dashboard's uploaded additional-costs file).
 *
 * A failed or shrunken import never replaces the last accepted catalog.
 */
import { contentHash } from './normalized.js';

export const CATALOG_TABLES = Object.freeze([
  'mcg_total', 'product_costs', 'sku_weights', 'sb_costs', 'hp_supplement',
  'hp_by_name', 'sku_alias', 'vendor_costs', 'vendor_index',
]);

/** Tables that must be non-empty for a catalog to be accepted at all. */
export const REQUIRED_NONEMPTY = Object.freeze(['mcg_total', 'vendor_costs', 'vendor_index']);

/** Known vendor-scoped SKU counts at Revision 5. Treated as floors, with tolerance. */
export const VENDOR_MINIMUMS = Object.freeze({
  'Live to Give': 30,
  'Lively Good': 171,
  'Calathea Collective': 462,
  'Surfside Arrangement': 11,
  'LindaMakes': 396,
});
export const VENDOR_TOTAL_MINIMUM = 1070;

const countOf = t => (t && typeof t === 'object') ? Object.keys(t).length : 0;

export function catalogCounts(catalog) {
  const tables = catalog?.tables || {};
  const tableCounts = Object.fromEntries(CATALOG_TABLES.map(n => [n, countOf(tables[n])]));
  tableCounts.mcgExtra = countOf(catalog?.mcgExtra);
  tableCounts.overrides = countOf(catalog?.overrides);
  const vendorCounts = Object.fromEntries(Object.entries(tables.vendor_costs || {}).map(([v, e]) => [v, countOf(e)]));
  const vendorTotal = Object.values(vendorCounts).reduce((s, n) => s + n, 0);
  return { tableCounts, vendorCounts, vendorTotal };
}

/**
 * Decide whether a newly imported catalog may become the active one.
 * @param {object} candidate  { tables, mcgExtra?, overrides?, meta? }
 * @param {object|null} previous  last accepted catalog's counts ({ tableCounts, vendorCounts, vendorTotal }) or null
 * @param {{ shrinkTolerance?: number, vendorMinimums?: object, vendorTotalMinimum?: number }} opts
 * @returns {{ accepted: boolean, reasons: string[], counts }}
 */
export function validateCatalog(candidate, previous = null, opts = {}) {
  const tol = opts.shrinkTolerance ?? 0.10;
  const mins = opts.vendorMinimums ?? VENDOR_MINIMUMS;
  const totalMin = opts.vendorTotalMinimum ?? VENDOR_TOTAL_MINIMUM;
  const counts = catalogCounts(candidate);
  const reasons = [];

  for (const t of REQUIRED_NONEMPTY) if (!counts.tableCounts[t]) reasons.push(`required table ${t} is empty or missing`);

  for (const [vendor, min] of Object.entries(mins)) {
    const n = counts.vendorCounts[vendor] || 0;
    if (n < Math.floor(min * (1 - tol))) reasons.push(`${vendor}: ${n} SKUs, below the expected ${min} by more than ${Math.round(tol * 100)}%`);
  }
  if (counts.vendorTotal < Math.floor(totalMin * (1 - tol))) {
    reasons.push(`vendor-scoped total ${counts.vendorTotal}, below the expected ${totalMin} by more than ${Math.round(tol * 100)}%`);
  }

  if (previous) {
    for (const [t, prevN] of Object.entries(previous.tableCounts || {})) {
      const n = counts.tableCounts[t] ?? 0;
      if (prevN > 0 && n < Math.floor(prevN * (1 - tol))) reasons.push(`${t}: ${n} entries, down from ${prevN} (more than ${Math.round(tol * 100)}% decrease)`);
    }
    for (const [v, prevN] of Object.entries(previous.vendorCounts || {})) {
      const n = counts.vendorCounts[v] ?? 0;
      if (prevN > 0 && n < Math.floor(prevN * (1 - tol))) reasons.push(`${v}: ${n} SKUs, down from ${prevN} (more than ${Math.round(tol * 100)}% decrease)`);
    }
  }
  return { accepted: reasons.length === 0, reasons, counts };
}

/** Content-addressed revision id: identical content reuses the same rev. */
export async function catalogRevOf(candidate) {
  const h = await contentHash({ tables: candidate.tables || {}, mcgExtra: candidate.mcgExtra || {}, overrides: candidate.overrides || {} });
  return `cat_${h.slice(0, 16)}`;
}

/** Catalog → the cost arguments calculate() takes, assembled exactly as index.html does. */
export function engineArgsFromCatalog(catalog) {
  const t = catalog?.tables || {};
  return {
    mcgCosts:        t.mcg_total || {},
    productCosts:    t.product_costs || {},
    skuWeights:      t.sku_weights || {},
    additionalCosts: { ...(t.hp_supplement || {}), ...(t.sb_costs || {}), ...(catalog?.overrides || {}) },
    hpByName:        t.hp_by_name || {},
    skuAlias:        t.sku_alias || {},
    mcgExtra:        catalog?.mcgExtra || {},
    vendorCosts:     t.vendor_costs || null,
    vendorIndex:     t.vendor_index || null,
  };
}

// ─── MCG extra costs ──────────────────────────────────────────────────────────

function parseCsvLineLikeEdge(line) {
  const result = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === ',' && !inQ) { result.push(cur); cur = ''; }
    else cur += c;
  }
  result.push(cur);
  return result;
}

/**
 * Port of the /api/mcg-extra parser in netlify/edge-functions/auth.js, kept
 * behavior-identical so the Worker and the dashboard resolve the same costs.
 * Note it splits on newlines before handling quotes, like the original; a quoted
 * field containing a newline would break both the same way. Fixing that is a
 * financial-logic change and is out of scope for this refactor.
 */
export function parseMcgExtraCsv(csv) {
  const lines = String(csv ?? '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return {};
  const headers = parseCsvLineLikeEdge(lines[0]);
  const skuIdx  = headers.findIndex(h => h.trim().toUpperCase() === 'SKU');
  const costIdx = headers.findIndex(h => h.trim().toUpperCase() === 'COST PER ITEM');
  if (skuIdx === -1 || costIdx === -1) return {};
  const descIdx = headers.findIndex(h => h.trim().toUpperCase() === 'DESCRIPTION');
  const result = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLineLikeEdge(lines[i]);
    const sku  = (cols[skuIdx] || '').trim().toUpperCase();
    const cost = parseFloat(cols[costIdx] || '');
    if (!sku || isNaN(cost) || cost <= 0) continue;
    result[sku] = cost;
    if (descIdx !== -1) {
      const desc = (cols[descIdx] || '').replace(/^[A-Z0-9]{4,}\s+/i, '');
      const name = desc.split('/')[0].toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
      if (name) result['__n__' + name] = cost;
    }
  }
  return result;
}
