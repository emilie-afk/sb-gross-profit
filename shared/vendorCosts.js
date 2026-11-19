/**
 * vendorCosts.js — vendor-aware product cost catalog
 * ===================================================
 * Each gift/arrangement vendor publishes its own cost tab, and the
 * same SKU string could in principle appear under more than one vendor. Costs
 * are therefore resolved by (vendor, SKU) — never by SKU alone — and a cost is
 * never silently borrowed from another vendor.
 *
 * Catalog shape (produced by build.py → data/vendor_costs.json):
 *   { "<vendor>": { "<SKU>": { unitCost, sku, productName, source, matchType } }, ... }
 *
 * All data stays in the browser.
 */

import { privateRules, vendorSkuPrefixRules } from './privateRules.js';
import { CATALOG_VENDORS, L2G } from './vendors.js';

// Catalog vendors are named by code (shared/vendors.js); full names are in the private legend.
export const VENDOR_KEYS = [...CATALOG_VENDORS];

// Shopify's Vendor column is free text and has drifted over time. The spellings seen
// map onto the canonical catalog vendor through the private rules (vendorAliases).

// SKU-prefix inference, used only when the Vendor column doesn't name a known vendor.
// The vendor-issued prefixes are private rules (vendorSkuPrefixes).

// Gift-box SKUs are words, not codes; their patterns are private rules (giftSkuPatternsCatalog).

export function normalizeSku(sku) {
  return String(sku ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

export function looseSku(sku) {
  return normalizeSku(sku).replace(/[^A-Z0-9]/g, '');
}

export function normalizeProductNameKey(name) {
  const last = String(name ?? '').split('\n').filter(s => s.trim()).pop() || '';
  return last.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Canonical vendor name for a free-text Shopify Vendor value, or ''. */
export function canonicalVendor(vendor) {
  const raw = String(vendor ?? '').trim();
  if (CATALOG_VENDORS.includes(raw)) return raw;            // already a vendor code
  const v = raw.toLowerCase().replace(/\s+/g, ' ');
  if (!v) return '';
  return privateRules().vendorAliases[v] || '';
}

/**
 * Which vendor catalog should be consulted for this line?
 * Vendor column first; SKU shape only as a fallback so a blank/renamed vendor
 * column doesn't silently drop a vendor's costs.
 */
export function inferVendorKey(sku, vendor) {
  const fromVendor = canonicalVendor(vendor);
  if (fromVendor) return fromVendor;
  const s = normalizeSku(sku);
  if (!s) return '';
  for (const [re, name] of vendorSkuPrefixRules()) if (re.test(s)) return name;
  if (privateRules().giftSkuPatternsCatalog.some(p => s.startsWith(p))) return L2G;
  return '';
}

/**
 * Build the secondary indexes (loose SKU, product name) for a catalog.
 * build.py precomputes these into vendor_index.json; this is the runtime
 * equivalent so tests and manual uploads work without a build step.
 */
export function buildVendorIndex(catalog) {
  const index = {};
  for (const [vendor, entries] of Object.entries(catalog || {})) {
    const byLooseSku = {}, byName = {};
    for (const [key, entry] of Object.entries(entries || {})) {
      const lk = looseSku(key);
      if (lk && !(lk in byLooseSku)) byLooseSku[lk] = key;
      const nk = normalizeProductNameKey(entry && entry.productName);
      if (nk && !(nk in byName)) byName[nk] = key;
    }
    index[vendor] = { byLooseSku, byName };
  }
  return index;
}

/**
 * Resolve a product cost from the vendor-scoped catalog.
 *
 * Lookup order (steps 1–3 of the documented cost resolution order):
 *   1. exact vendor + exact SKU
 *   2. vendor + normalized (punctuation-stripped) SKU
 *   3. vendor + product-name match
 *
 * Returns null when the vendor is unknown or has no matching product, so the
 * caller can fall through to the existing MCG / alias / manual / generic
 * sources. Never returns another vendor's cost.
 */
export function resolveVendorCost(sku, vendor, catalog, index = null, productName = '') {
  if (!catalog) return null;
  const vendorKey = inferVendorKey(sku, vendor);
  if (!vendorKey) return null;
  const entries = catalog[vendorKey];
  if (!entries) return null;
  const idx = (index && index[vendorKey]) || buildVendorIndex({ [vendorKey]: entries })[vendorKey];

  const exact = normalizeSku(sku);
  if (exact && entries[exact]) {
    return { ...entries[exact], vendor: vendorKey, matchType: 'exact_sku',
             source: entries[exact].source || `${vendorKey} sheet` };
  }

  const loose = looseSku(sku);
  if (loose && idx.byLooseSku[loose]) {
    const hit = entries[idx.byLooseSku[loose]];
    return { ...hit, vendor: vendorKey, matchType: 'normalized_sku',
             source: hit.source || `${vendorKey} sheet` };
  }

  const nameKey = normalizeProductNameKey(productName);
  if (nameKey && idx.byName[nameKey]) {
    const hit = entries[idx.byName[nameKey]];
    return { ...hit, vendor: vendorKey, matchType: 'vendor_product_name',
             source: hit.source || `${vendorKey} sheet` };
  }

  return null;
}

/** Cost coverage across a set of calculated line items. */
export function costCoverage(lines) {
  const soldSkus = new Set(), matchedSkus = new Set();
  let units = 0, matchedUnits = 0, revenue = 0, matchedRevenue = 0;
  for (const li of lines) {
    const key = normalizeSku(li.sku);
    if (!key) continue;
    soldSkus.add(key);
    units += li.qty || 0;
    revenue += li.lineRevenue || 0;
    if (!li.missingCost) {
      matchedSkus.add(key);
      matchedUnits += li.qty || 0;
      matchedRevenue += li.lineRevenue || 0;
    }
  }
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
  return {
    soldSkus: soldSkus.size, matchedSkus: matchedSkus.size,
    units, matchedUnits, revenue: Math.round(revenue * 100) / 100,
    matchedRevenue: Math.round(matchedRevenue * 100) / 100,
    skuPct: pct(matchedSkus.size, soldSkus.size),
    unitPct: pct(matchedUnits, units),
    revenuePct: pct(matchedRevenue, revenue),
    complete: matchedSkus.size === soldSkus.size,
  };
}
