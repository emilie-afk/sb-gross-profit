/**
 * vendorCosts.js — vendor-aware product cost catalog
 * ===================================================
 * The four gift/arrangement vendors each publish their own cost tab, and the
 * same SKU string could in principle appear under more than one vendor. Costs
 * are therefore resolved by (vendor, SKU) — never by SKU alone — and a cost is
 * never silently borrowed from another vendor.
 *
 * Catalog shape (produced by build.py → data/vendor_costs.json):
 *   { "Live to Give": { "PRAY DLX": { unitCost, sku, productName, source, matchType } }, ... }
 *
 * All data stays in the browser.
 */

export const LIVE_TO_GIVE         = 'Live to Give';
export const LIVELY_GOOD          = 'Lively Good';
export const CALATHEA_COLLECTIVE  = 'Calathea Collective';
export const SURFSIDE_ARRANGEMENT = 'Surfside Arrangement';

export const VENDOR_KEYS = [
  LIVE_TO_GIVE, LIVELY_GOOD, CALATHEA_COLLECTIVE, SURFSIDE_ARRANGEMENT,
];

// Shopify's Vendor column is free text and has drifted over time. Map the
// spellings we have seen onto the canonical catalog vendor.
const VENDOR_ALIASES = {
  'live to give': LIVE_TO_GIVE,
  'livetogive': LIVE_TO_GIVE,
  'live 2 give': LIVE_TO_GIVE,
  'lively good': LIVELY_GOOD,
  'livelygood': LIVELY_GOOD,
  'lively root': LIVELY_GOOD,
  'livelyroot': LIVELY_GOOD,
  'calathea collective': CALATHEA_COLLECTIVE,
  'calatheacollective': CALATHEA_COLLECTIVE,
  'calathea': CALATHEA_COLLECTIVE,
  'surfside arrangement': SURFSIDE_ARRANGEMENT,
  'surfside arrangements': SURFSIDE_ARRANGEMENT,
  'surfside succulents': SURFSIDE_ARRANGEMENT,
  'surfside': SURFSIDE_ARRANGEMENT,
};

// SKU-prefix inference, used only when the Vendor column doesn't name a known
// vendor. These prefixes are vendor-issued and unique to that vendor's tab.
const VENDOR_SKU_PREFIXES = [
  [/^CC-/i,          CALATHEA_COLLECTIVE],
  [/^SUR-/i,         SURFSIDE_ARRANGEMENT],
  [/^(PL|PB)_/i,     LIVELY_GOOD],
];

// Live to Give SKUs are words, not codes ("Pray DLX", "TY simple").
const LIVE_TO_GIVE_PATTERNS = [
  'PRAY DLX', 'PRAY PP', 'PRAY ', 'SYM DLX', 'SYM DELUXE', 'SYM ', 'DOG PET', 'CAT PET',
  'IVF ', 'SUN ', 'WAR ', 'WOMAN', 'POS ', 'TOY ', 'BDAY', 'NURSE',
  'TEACHER', 'GRAND', 'MAMA', 'TY ', 'GB-',
];

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
  const v = String(vendor ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!v) return '';
  return VENDOR_ALIASES[v] || '';
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
  for (const [re, name] of VENDOR_SKU_PREFIXES) if (re.test(s)) return name;
  if (LIVE_TO_GIVE_PATTERNS.some(p => s.startsWith(p))) return LIVE_TO_GIVE;
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
