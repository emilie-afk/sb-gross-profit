/**
 * GP Calculator — JavaScript port of calculate_gp.py
 * All data stays in the browser. No network requests.
 */

import { resolveVendorCost, inferVendorKey } from './vendorCosts.js';

// ─── Constants ────────────────────────────────────────────────────────────────

// Volume discount per plant based on total MCG plant units in the order
// (confirmed fulfillment cost reduction from MCG)
const MCG_VOL_DISC_TIERS = [
  { min: 8, disc: 0.65 },
  { min: 4, disc: 0.55 },
  { min: 2, disc: 0.25 },
];

const MCG_TIER = {
  '2inch':      4.00,  // Succulents 2"
  '2inch_pot':  5.00,  // Succulents 2" Pot Upgrade
  '4inch':      6.00,  // Succulents 4"
  '4inch_pot':  7.20,  // Succulents 4" Pot Upgrade
  'sub':        3.00,  // Subscription 2"
  'sub_pot':    4.00,  // Subscription 2" Pot Upgrade
  'faire_pack': 1.15,  // Faire Pack 2" (64-pack)
  'faire_2':    3.00,  // Faire Ala Carte 2"
  'faire_4':    5.00,  // Faire Ala Carte 4"
  'pack':       2.00,  // Rack/Pack (RAKN/RAKZ/RAJZ/RAJN) — $2/plant × count from SKU
  'airplant':   3.00,  // Tillandsia airplants (PPJZ/PPKZ) — $3/fulfillment
};

const MCG_PREFIXES = [
  'S1','S2','S3','SX','C2','C3','CX',
  'EEZZ','EBZZ','EEVZ','PPKZ','PPJZ',
  'RAKN','RAKZ','RAJZ','RAJN','TAKM','XAZZ','AJN','MODERNPOT','1001','1002','1005','1014',
  '1050','1055','1064','1075','1079','1083','1090','1110',
  '1114','1237','1253','1264','1311','1313','1340','BD-','4X-','E1031',
  'SUB','GSUB',
  'TAKM','XAZZ',
  'JN',
];

const HP_SHIP_RATES = [
  [0.75,8.45],[1.00,10.10],[1.50,12.30],[3.00,16.75],[5.00,21.30],
  [8.00,27.20],[12.00,32.50],[16.00,39.20],[20.00,46.10],[40.00,61.90],
  [50.00,110.30],[60.00,146.40],[70.00,168.90],[80.00,200.00],[100.00,236.00]
];

const HP_SIZE_FALLBACK_LB = {
  '2':0.75,'3':0.75,'4':1.00,'6':3.00,'8':6.00,'AIR':0.13,'BUNDLE':3.00
};

const HP_VENDORS = new Set([
  'House Plant Dropship','House Plant Wholesale','House Plant Shop'
]);

const LIVE_TO_GIVE_PATTERNS = [
  'PRAY DLX','PRAY PP','PRAY ','SYM DLX','SYM ','DOG PET','CAT PET',
  'IVF ','SUN ','WAR ','WOMAN','POS ','TOY ','BDAY','NURSE',
  'TEACHER','GRAND','MAMA','TY ','GB-'
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

// For SUB/GSUB subscription SKUs, return the number of months so revenue,
// COGS, and shipping can be normalized to per-delivery figures.
// e.g. SUB5-1-12 → 12,  GSUB4-4-3 → 3,  SUB2-3-6 → 6
// Non-subscription SKUs return 1 (no division needed).
function getSubMonths(sku) {
  const s = (sku || '').toUpperCase();
  if (!s.startsWith('SUB') && !s.startsWith('GSUB')) return 1;
  const parts = s.split('-');
  const nums = parts.map(p => parseInt(p, 10)).filter(n => !isNaN(n) && n >= 1 && n <= 24);
  if (!nums.length) return 1;
  // The last numeric segment is the months count
  return nums[nums.length - 1];
}

// Normalize Shopify "Source name" values to human-readable channel labels.
// Sellbrite imports Amazon/eBay/Etsy/Walmart orders via the Shopify sales channel.
function normalizeChannel(rawSource) {
  const s = (rawSource || '').toLowerCase().trim();
  if (!s || s === 'web')                          return 'Web';
  if (s === 'pos')                                return 'POS';
  if (s.includes('tiktok'))                       return 'TikTok';
  if (s === 'instagram' || s === 'ig')            return 'Instagram';
  if (s === 'facebook' || s === 'fb')             return 'Facebook';
  if (s === 'google' || s === 'google shopping')  return 'Google';
  if (s === 'amazon' || s.includes('amazon'))     return 'Amazon';
  if (s === 'ebay'   || s.includes('ebay'))       return 'eBay';
  if (s === 'etsy'   || s.includes('etsy'))       return 'Etsy';
  if (s === 'walmart')                            return 'Walmart';
  // Sellbrite imports from marketplace channels — tag as Amazon if SKU prefix
  // matches, otherwise just label by the raw source
  if (s === 'sellbrite')                          return 'Amazon';
  return rawSource.trim() || 'Other';
}

function identifyStore(sku, vendor) {
  const s = (sku || '').toUpperCase().trim();
  const v = (vendor || '').trim();
  if (s.startsWith('AS-'))           return 'Air Plant Shop';
  if (LIVE_TO_GIVE_PATTERNS.some(p => s.startsWith(p.toUpperCase()))) return 'Live to Give';
  if (s.startsWith('MG-'))           return 'Succulents Box (17381)';
  if (s.startsWith('FH-'))           return 'House Plant Dropship';
  if (s.startsWith('4INSUCCULENTS')) return 'Succulents Box (17381)';
  // Check vendor BEFORE numeric fallback — HP products with no SKU code should still be identified
  if (HP_VENDORS.has(v))             return v;
  if (v === 'Succulents Box')        return 'Succulents Box (17381)';
  if (/^\d+$/.test(s))               return 'Unknown (no SKU set)';
  return v || 'Unknown';
}

function normalizeProductName(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function isMcgSku(sku) {
  const s = sku.toUpperCase();
  return MCG_PREFIXES.some(p => s.startsWith(p.toUpperCase()));
}

// Returns the discount per plant for a given total plant count in the order
function getMcgVolumeDisc(plantCount) {
  for (const t of MCG_VOL_DISC_TIERS) {
    if (plantCount >= t.min) return t.disc;
  }
  return 0;
}

// Returns number of MCG plant units for sku×qty.
// Pots, Faire wholesale, and non-MCG SKUs return 0.
function mcgPlantUnits(sku, qty) {
  const s = (sku || '').toUpperCase();
  if (!isMcgSku(sku)) return 0;
  // Pots — not plants
  if (s.startsWith('EEZZ') || s.startsWith('EBZZ') || s.startsWith('EEVZ') ||
      s.startsWith('MODERNPOT')) return 0;
  // Faire wholesale — different pricing model, exclude from volume discount
  if (s.startsWith('BD-') || s.startsWith('4X-')) return 0;
  // Subscriptions — excluded from volume discount
  if (s.startsWith('SUB') || s.startsWith('GSUB')) return 0;
  // Rack/Pack SKUs — flat $2/plant pricing, no volume discount applies
  if (s.startsWith('RAKN') || s.startsWith('RAKZ') || s.startsWith('RAJZ') || s.startsWith('RAJN') ||
      s.startsWith('TAKM') || s.startsWith('XAZZ') || s.startsWith('AJN')) return 0;
  // xN suffix: multi-plant pack (e.g. S2JY1492x2 = 2 plants per unit)
  const pack = parsePackSuffix(s);
  if (pack) return pack.n * qty;
  // Default: 1 plant per unit
  return qty;
}

/**
 * Multi-plant pack suffix: "S2JY1492x2" = 2 plants per unit.
 *
 * The suffix is only real when the part before it is a full MCG SKU and the
 * count is a plausible pack size. Without those guards a plain species SKU that
 * happens to contain an 'x' before digits is read as a giant pack — the real
 * case was S2Kx1125 (one $7.20 cactus) being priced as a 1,125-plant pack at
 * ~$3,769 and dragging its whole order into the top volume-discount tier.
 *
 * Every genuine pack SKU in the Jul–Sep 2026 exports is <8+ char base>x2/x4/x8.
 */
const MAX_PACK_SIZE = 24;
function parsePackSuffix(skuUpper) {
  const m = (skuUpper || '').match(/X(\d+)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!(n >= 2 && n <= MAX_PACK_SIZE)) return null;
  const base = skuUpper.slice(0, skuUpper.length - m[0].length);
  // A real base SKU looks like S2KY1048 / CXVY6173 / S2JN57772 — never "S2K".
  if (base.length < 8 || !/\d$/.test(base)) return null;
  return { base, n };
}

function mcgTierCost(sku, mcgCosts) {
  const s = sku.toUpperCase();
  // If it's already in mcgCosts (Total sheet), skip tier fallback — caller handles this
  // Faire Pack: 4X- prefix
  if (s.startsWith('4X-'))                                  return [MCG_TIER.faire_pack, 'MCG tier (Faire Pack 2")'];
  // Faire Ala Carte: BD- prefix, or SKU contains FAIRE
  if (s.startsWith('BD-') || s.includes('FAIRE')) {
    if (['S3','C3','SX','CX','S1'].some(p=>s.includes(p))) return [MCG_TIER.faire_4,    'MCG tier (Faire 4")'];
    return [MCG_TIER.faire_2,                                                            'MCG tier (Faire 2")'];
  }
  // Subscription pot upgrade
  if ((s.startsWith('SUB')||s.startsWith('GSUB')) && (s.includes('POT') || s.includes('UPGRADE')))
                                                            return [MCG_TIER.sub_pot,   'MCG tier (Sub Pot Upgrade)'];
  // Subscription base — $3/plant × plants/mo × months
  // SKU patterns:
  //   GSUB7-1-6  = 1 plant/mo × 6 months  → cost $3 × 1 × 6 = $18
  //   GSUBPOT-2-6 = 2 plants/mo × 6 months → cost $3 × 2 × 6 = $36
  //   GSUBPOT-3-3 = 3 plants/mo × 3 months → cost $3 × 3 × 3 = $27
  if (s.startsWith('SUB') || s.startsWith('GSUB')) {
    // Split on dashes, parse each segment's leading integer (parseInt stops at non-digit)
    const nums = s.split('-').map(p => parseInt(p, 10)).filter(n => n > 0 && n <= 50);
    // Second-to-last number = plants/mo; last = months
    const plants = nums.length >= 2 ? nums[nums.length - 2] : (nums[0] || 1);
    // Return PER-DELIVERY cost only (plants × $3).
    // The MCG sheet also stores per-delivery cost, so both paths are consistent.
    // months are handled separately by getSubMonths() on the revenue side.
    const perDelivery = Math.round(MCG_TIER.sub * plants * 100) / 100;
    return [perDelivery, `MCG tier (Sub ${plants}×$${MCG_TIER.sub}/mo)`];
  }
  // 2" pot upgrade: S2/C2 + POT or UPGRADE in SKU
  if ((s.startsWith('S2')||s.startsWith('C2')) && (s.includes('POT')||s.includes('UPGRADE')))
                                                            return [MCG_TIER['2inch_pot'],'MCG tier (2" Pot Upgrade)'];
  // 4" pot upgrade: S3/C3/SX/CX/S1 + POT or UPGRADE in SKU
  if (['S3','C3','SX','CX','S1'].some(p=>s.startsWith(p)) && (s.includes('POT')||s.includes('UPGRADE')))
                                                            return [MCG_TIER['4inch_pot'],'MCG tier (4" Pot Upgrade)'];
  // Tillandsia airplants (PPJZ/PPKZ) — 2" plant tier (not in pot sheet)
  if (s.startsWith('PPJZ') || s.startsWith('PPKZ'))        return [MCG_TIER.airplant,   'MCG tier (airplant 2")'];
  // xN suffix: multi-plant pack — multiply tier cost by pack size
  {
    const pack = parsePackSuffix(s);
    if (pack) {
      const { base, n } = pack;
      // Determine tier from base SKU prefix
      let tierCost = null, tierLabel = null;
      if (base.startsWith('S2')||base.startsWith('C2')) { tierCost = MCG_TIER['2inch']; tierLabel = '2"'; }
      else if (['S3','C3','SX','CX','S1'].some(p=>base.startsWith(p))) { tierCost = MCG_TIER['4inch']; tierLabel = '4"'; }
      if (tierCost !== null) return [Math.round(tierCost * n * 100) / 100, `MCG tier (${tierLabel} ×${n})`];
    }
  }
  // 2" base
  if (s.startsWith('S2')||s.startsWith('C2')||s.startsWith('E1031'))
                                                            return [MCG_TIER['2inch'],   'MCG tier (2")'];
  // 4" base
  if (['S3','C3','SX','CX','S1'].some(p=>s.startsWith(p))) return [MCG_TIER['4inch'],   'MCG tier (4")'];
  // Rack/Pack: RAKN/RAKZ/RAJZ — $2/plant × count (last numeric segment of SKU)
  // e.g. RAKN2918-6 → 6 plants → $12
  if (s.startsWith('RAKN') || s.startsWith('RAKZ') || s.startsWith('RAJZ') || s.startsWith('RAJN') ||
      s.startsWith('TAKM') || s.startsWith('XAZZ')) {
    const parts = s.split('-');
    const count = parseInt(parts[parts.length - 1], 10);
    if (count >= 6 && count <= 500) {
      const total = Math.round(MCG_TIER.pack * count * 100) / 100;
      return [total, `MCG tier (Pack ${count}×$${MCG_TIER.pack})`];
    }
    // count < 6: suffix is a legacy/invalid variant ID — SKU doesn't exist, skip it
    return [null, null];
  }
  return [null, null];
}

/**
 * Resolve a unit cost.
 *
 * Returns [unitCost, costSource, matchType]. Historical callers that
 * destructure two elements keep working unchanged.
 *
 * Resolution order:
 *   0.  hard overrides (gift card / printable / Route / rack-pack)
 *   1.  vendor-scoped catalog — exact vendor + exact SKU
 *   2.  vendor-scoped catalog — vendor + normalized SKU
 *   3.  vendor-scoped catalog — vendor + product-name match
 *   4.  existing MCG rules (Total sheet, pot variants, extra, tier fallback)
 *   5.  products export / manual uploaded costs / HP-by-name  (unchanged order)
 *   6.  SKU alias mapping
 *   7.  generic SKU-only fallback + MCG size fallback
 *   8.  missing
 *
 * Steps 5–7 keep the exact relative order the historical calculator already
 * used, so no previously-matched SKU changes source. Only the new vendor
 * catalog is inserted ahead of them, and it can never return another vendor's
 * cost.
 */
function getCost(sku, vendor, mcgCosts, productCosts, additionalCosts, hpByName, productName, skuAlias = {}, mcgExtra = {}, vendorCosts = null, vendorIndex = null) {
  const key = (sku || '').toUpperCase().trim();

  // 1. Vendor catalog, exact vendor + exact SKU. This runs before the composite
  //    split because some vendor SKUs legitimately contain a '+' — e.g. Surfside's
  //    SUR-WHITEPOT-ROSETTE+DONKEY, which is one product, not a bundle of
  //    "SUR-WHITEPOT-ROSETTE" and "DONKEY". A real catalog entry always beats a
  //    speculative split.
  if (vendorCosts) {
    const exactHit = resolveVendorCost(sku, vendor, vendorCosts, vendorIndex, productName);
    if (exactHit && exactHit.matchType === 'exact_sku' && typeof exactHit.unitCost === 'number') {
      return [exactHit.unitCost, exactHit.source, exactHit.matchType];
    }
  }

  // Composite SKU: "S3KY2997+EEZZ7650" = two products bundled — sum both costs
  if (key.includes('+')) {
    const parts = key.split('+').map(p => p.trim()).filter(Boolean);
    let total = 0;
    const labels = [];
    for (const part of parts) {
      const [c, l] = getCost(part, vendor, mcgCosts, productCosts, additionalCosts, hpByName, null, skuAlias, mcgExtra, vendorCosts, vendorIndex);
      if (c === null) return [null, 'COST MISSING', 'missing'];
      total += c;
      labels.push(`${part}:${l}`);
    }
    return [Math.round(total * 100) / 100, 'Bundle (' + labels.join(' + ') + ')', 'bundle'];
  }

  // Rack/Pack SKUs (MCG only): detect by product name containing "PACK" + MCG vendor.
  // Must be resolved first — before any name-based overrides — so the flat $2 override
  // doesn't short-circuit us. We use the name to confirm it's a pack, then the dash-
  // suffix to get the plant count (e.g. AJN1376-20 → 20 plants → $2×20 = $40).
  const _prodUp = (productName || '').toUpperCase();
  const _rackParts = key.split('-');
  const _rackCount = parseInt(_rackParts[_rackParts.length - 1], 10);
  const isRackSku = isMcgSku(sku) &&
                    _prodUp.includes('PACK') &&
                    _rackParts.length >= 2 &&
                    !isNaN(_rackCount) && _rackCount >= 2;
  if (isRackSku) {
    const total = Math.round(MCG_TIER.pack * _rackCount * 100) / 100;
    return [total, `MCG tier (Pack ${_rackCount}×$${MCG_TIER.pack})`];
  }

  // 0. Hard overrides — these take priority over the MCG Total sheet
  // Gift cards — no physical cost
  if (/^GC\d/i.test(key)) return [0.00, 'Gift Card (no COGS)'];
  // Printables — digital products, zero COGS
  {
    const nameU = (productName || '').toUpperCase();
    if (nameU.startsWith('PRINTABLE') || nameU.startsWith('FREE PRINTABLE')) {
      return [0.00, 'Printable (no COGS)'];
    }
  }
  // Random/assorted 2" MCG succulents (JN prefix, no size prefix like S2/C2)
  // These are bulk-assorted plants at $2/plant, not the specific-species $4 tier
  if (/^JN\d/i.test(key)) return [2.00, 'MCG tier (Random 2" $2)'];
  // Random succulents / succulent packs — $2/plant regardless of species
  // Matches: SKU contains RANDOM, or product name contains "random" or "succulent pack"
  // NOTE: rack/pack SKUs (TAKM/RAKN etc.) are already handled above and never reach here
  {
    const nameU = (productName || '').toUpperCase();
    if (key.includes('RANDOM') ||
        nameU.includes('RANDOM') ||
        nameU.includes('SUCCULENT PACK')) {
      return [2.00, 'Random/Pack succulent ($2)'];
    }
  }

  // 2–3. Vendor-scoped catalog, normalized SKU then product name (the exact-SKU
  //      pass already ran at the top). Resolved per vendor so one vendor's cost
  //      is never used for another's product. Unknown vendor → null → falls
  //      through to the legacy sources.
  if (vendorCosts) {
    const hit = resolveVendorCost(sku, vendor, vendorCosts, vendorIndex, productName);
    if (hit && typeof hit.unitCost === 'number') {
      return [hit.unitCost, hit.source, hit.matchType];
    }
  }

  // 4. MCG Total sheet has the exact cost — always wins over generic sources
  if (mcgCosts[key] !== undefined) return [mcgCosts[key], 'MCG Total sheet', 'mcg_sheet'];
  // 1b. Pot SKU dot-variant suffix (e.g. EEZZ7650.WH → try base EEZZ7650)
  //     Single-unit costs like EEZZ7620.BR-1 are stored directly in mcgCosts (step 1 above)
  if (key.includes('.')) {
    const base = key.split('.')[0];
    if (mcgCosts[base] !== undefined) return [mcgCosts[base], 'MCG Pot Costs'];
  }
  // 1c. Pot SKU dash-variant suffix (e.g. EEZZ2741-1 → try base EEZZ2741)
  //     Only for pot SKU prefixes to avoid breaking BD-/4X-/other dash-prefixed SKUs
  if ((key.startsWith('EEZZ') || key.startsWith('EBZZ') || key.startsWith('EEVZ')) && key.includes('-')) {
    const base = key.split('-')[0];
    if (mcgCosts[base] !== undefined) return [mcgCosts[base], 'MCG Pot Costs (dash variant)'];
  }
  // 2. HP/product costs baked in at deploy time
  if (productCosts[key] !== undefined) return [productCosts[key], 'Products export'];
  // 3. Manually uploaded costs CSV
  if (additionalCosts && additionalCosts[key] !== undefined) return [additionalCosts[key], 'Manual costs'];
  // 4. MCG extra costs — SKUs not in mcg_total.json but with a known Cost Per Item (col F).
  //    Use the full value directly; tier is skipped. Volume discount applies to this total.
  if (mcgExtra && mcgExtra[key] !== undefined) return [mcgExtra[key], 'MCG extra'];
  // 4b. MCG extra name match — for variant SKUs not in sheet, match by normalized plant name.
  //     Checks mcgExtra (runtime proxy) first, then mcgCosts (baked into mcg_total.json at
  //     deploy time by build.py — now includes __n__ entries).
  //     e.g. "S2KY5477 / Dormant - Plastic Pot" → strip variant → match "frizzle sizzle albuca spiralis 2 inch"
  if (productName) {
    const normName = productName.split('/')[0]
      .toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (normName) {
      if (mcgExtra && mcgExtra['__n__' + normName] !== undefined)
        return [mcgExtra['__n__' + normName], 'MCG extra (name match)'];
      if (mcgCosts && mcgCosts['__n__' + normName] !== undefined)
        return [mcgCosts['__n__' + normName], 'MCG sheet (name match)'];
    }
  }
  // 5. MCG tier fallback — last resort for MCG SKUs with no cost data at all
  if (isMcgSku(sku)) {
    const [tierCost, tierLabel] = mcgTierCost(sku, mcgCosts);
    if (tierCost !== null) return [tierCost, tierLabel];
  }
  // 5. HP name-based fallback — for orders where SKU is a Shopify variant ID (all digits)
  //    Match normalized product title against hp_by_name built from product export
  if (hpByName && productName && /^\d+$/.test(key)) {
    const norm = normalizeProductName(productName);
    if (hpByName[norm] !== undefined) return [hpByName[norm], 'HP by name'];
    // Prefix match: order title may include vendor suffix e.g. "Fern Heart 4 inch  lucky hearts"
    // while export title is "Fern Heart 4 inch"
    for (const [k, v] of Object.entries(hpByName)) {
      if (norm.startsWith(k)) return [v, 'HP by name'];
    }
  }
  // 6. SKU alias fallback — Amazon/channel alias → canonical SB/MCG/HP SKU
  //    If the order came in with an Amazon seller SKU, map it to the real SKU and re-lookup
  if (skuAlias && skuAlias[key] && skuAlias[key] !== key) {
    const canonical = skuAlias[key];
    return getCost(canonical, vendor, mcgCosts, productCosts, additionalCosts, hpByName, productName, {}, mcgExtra, vendorCosts, vendorIndex);
    // pass empty alias to avoid infinite loops if canonical itself is aliased
  }
  // 7. MCG vendor + product name size fallback
  //    Handles specialty MCG plants (Mangave, etc.) not yet in the cost sheet.
  //    Rule: 1.5" Plug = 2" succulent tier; 2" = 2" tier; 4" = 4" tier.
  if ((vendor || '').toLowerCase().includes('succulents box') ||
      (vendor || '').toLowerCase() === 'succulents box') {
    const n = (productName || '');
    if (/\b1\.5["'′]?\s*(plug|inch|in\b)/i.test(n) || /\(1\.5["\s]/i.test(n))
      return [MCG_TIER['2inch'], 'MCG size fallback (1.5" plug → 2" tier)'];
    if (/\b2["'′]?\s*(plug|inch|in\b)/i.test(n) || /\(2["\s]/i.test(n))
      return [MCG_TIER['2inch'], 'MCG size fallback (2" tier)'];
    if (/\b4["'′]?\s*(plug|inch|in\b)/i.test(n) || /\(4["\s]/i.test(n))
      return [MCG_TIER['4inch'], 'MCG size fallback (4" tier)'];
  }
  return [null, 'COST MISSING', 'missing'];
}

/** Derive a stable match-method token from a legacy cost-source label. */
function labelToMatchType(label) {
  if (!label) return 'unknown';
  const l = String(label);
  if (l === 'COST MISSING')              return 'missing';
  if (l.startsWith('Bundle'))            return 'bundle';
  if (l.startsWith('MCG Total sheet'))   return 'mcg_sheet';
  if (l.startsWith('MCG Pot Costs'))     return 'mcg_pot_sheet';
  if (l.startsWith('MCG extra (name'))   return 'mcg_extra_name';
  if (l.startsWith('MCG sheet (name'))   return 'mcg_sheet_name';
  if (l.startsWith('MCG extra'))         return 'mcg_extra';
  if (l.startsWith('MCG tier'))          return 'mcg_tier';
  if (l.startsWith('MCG size fallback')) return 'mcg_size_fallback';
  if (l.startsWith('Products export'))   return 'generic_sku';
  if (l.startsWith('Manual costs'))      return 'manual_upload';
  if (l.startsWith('HP by name'))        return 'hp_product_name';
  if (l.startsWith('Gift Card'))         return 'override_gift_card';
  if (l.startsWith('Printable'))         return 'override_digital';
  if (l.startsWith('Route'))             return 'override_route';
  if (l.startsWith('Random/Pack'))       return 'override_random_pack';
  if (l.endsWith('sheet'))               return 'exact_sku';
  return 'other';
}

// Deprecated for expense calculation: House Plant Dropship shipping is now taken
// from the HPD log or passed through from the Shopify shipping the customer
// paid. Retained only for the informational weight note on mixed orders.
function hpShipRate(totalLb) {
  for (const [max, cost] of HP_SHIP_RATES) {
    if (totalLb <= max) return cost;
  }
  return HP_SHIP_RATES[HP_SHIP_RATES.length - 1][1];
}

function getHpItemWeight(sku, skuWeights) {
  const key = (sku || '').toUpperCase().trim();
  if (skuWeights[key]) return skuWeights[key];
  const prefix = key.includes('_') ? key.split('_')[0] : '';
  return HP_SIZE_FALLBACK_LB[prefix] || 1.00;
}

function cleanMoney(val) {
  if (val === null || val === undefined) return null;
  const n = parseFloat(String(val).replace(/[$,]/g, '').trim());
  return isNaN(n) ? null : n;
}

// ─── CSV Parser ───────────────────────────────────────────────────────────────

/**
 * RFC 4180 CSV parser.
 *
 * This used to split on newlines first and parse each line separately, which
 * silently corrupted any record containing a quoted field with an embedded
 * newline. Shopify's 'Notes' and 'Note Attributes' columns regularly do: in the
 * Jul 2026 export 995 of 3,788 line records (26%) were affected, and because
 * those two columns sit at positions 45-46, everything after them — Cancelled
 * at, Refunded Amount, Vendor, Tags, Source and Lineitem discount — was lost or
 * shifted on those records, while each stray fragment became a phantom row
 * (5,340 rows parsed from 3,794 real records).
 */
export function parseCSV(text) {
  const all = _parseRfc4180(text);
  if (!all.length) return [];
  const headers = all[0];
  const rows = [];
  for (let i = 1; i < all.length; i++) {
    const vals = all[i];
    if (!vals.some(v => String(v).trim())) continue;
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = vals[idx] ?? ''; });
    rows.push(obj);
  }
  return rows;
}

function parseCSVRow(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i+1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// ─── Additional costs CSV parser ──────────────────────────────────────────────
// Parses the "Download SKUs" CSV once costs are filled in: SKU,Vendor,Product,Cost
export function parseAdditionalCosts(rows) {
  const costs = {};
  for (const row of rows) {
    const sku  = (row['SKU'] || '').trim().toUpperCase();
    const cost = cleanMoney(row['Cost']);
    if (sku && cost !== null && cost > 0) costs[sku] = cost;
  }
  return costs;
}

// ─── ShipStation parser ───────────────────────────────────────────────────────

/** Shopify writes order names as "#472351"; ShipStation writes "472351". */
export function normalizeOrderNumber(num) {
  return String(num ?? '').trim().replace(/^#+/, '');
}

export function parseShipStation(rows) {
  // Returns { costs: Map<orderNum, totalShippingPaid>, apsCosts, shipments }
  //
  // ShipStation repeats the shipment's shipping cost on every item row, so the
  // cost column is NEVER summed across raw rows. Instead:
  //   1. group by Shipment # within Order #
  //   2. count the shipping cost once per unique shipment
  //   3. sum the unique shipments belonging to the same Order #
  // An order can legitimately have more than one shipment.
  //
  // WHICH COLUMN IS THE EXPENSE
  // ---------------------------
  // ShipStation exports carry BOTH 'Rate' and 'Shipping Paid', and they are not
  // the same thing:
  //   Rate          = what the label cost us          → this is the expense
  //   Shipping Paid = what the customer paid us       → this is revenue
  // Verified against the July 2026 export: 'Shipping Paid' equals Shopify's
  // order-level 'Shipping' on 460 of 461 joined orders, while 'Rate' matches on
  // 5. Treating 'Shipping Paid' as the expense would book shipping revenue as a
  // cost. So 'Rate' is the expense whenever the column exists, and
  // 'Shipping Paid' is used only as a fallback for exports that omit 'Rate'.
  //
  // apsCosts is populated only in line-items format (APS shipments identified
  // by the AS- SKU prefix).
  const costs     = new Map();
  const apsCosts  = new Map();
  const shipments = new Map(); // orderNum → [{ shipmentId, cost }]

  if (!rows.length) return { costs, apsCosts, shipments };

  const keys = Object.keys(rows[0]).map(k => k.trim());
  const isLineItems = keys.includes('Shipment #');
  const pick = (row, names) => {
    for (const n of names) {
      const k = Object.keys(row).find(kk => kk.trim().toLowerCase() === n.toLowerCase());
      if (k !== undefined && String(row[k]).trim() !== '') return row[k];
    }
    return '';
  };
  // 'Rate' first — see the note above; 'Shipping Paid' is a fallback only.
  const COST_COLS = ['Rate', 'Shipping Paid'];
  const hasRateCol = keys.some(k => k.toLowerCase() === 'rate');
  const costColumnUsed = hasRateCol ? 'Rate' : (keys.some(k => k.toLowerCase() === 'shipping paid') ? 'Shipping Paid' : 'none');

  if (isLineItems) {
    // Pass 1: collect cost + APS flag per shipment (first row per shipment wins)
    const shipRate = new Map();  // shipmentId → { rate, orderNum }
    const shipHasAps = new Map(); // shipmentId → bool

    for (const row of rows) {
      const shipId   = String(pick(row, ['Shipment #'])).trim();
      const orderNum = normalizeOrderNumber(pick(row, ['Order #']));
      const rate     = cleanMoney(pick(row, COST_COLS)) || 0;
      const sku      = String(pick(row, ['Item SKU'])).trim();
      if (!shipId || !orderNum) continue;
      if (!shipRate.has(shipId)) shipRate.set(shipId, { rate, orderNum });
      if (sku.startsWith('AS-')) shipHasAps.set(shipId, true);
    }

    // Pass 2: accumulate per order
    for (const [shipId, { rate, orderNum }] of shipRate) {
      costs.set(orderNum, (costs.get(orderNum) || 0) + rate);
      if (!shipments.has(orderNum)) shipments.set(orderNum, []);
      shipments.get(orderNum).push({ shipmentId: shipId, cost: rate });
      if (shipHasAps.get(shipId)) {
        apsCosts.set(orderNum, (apsCosts.get(orderNum) || 0) + rate);
      }
    }
  } else {
    // Summary format: one row per shipment already
    for (const row of rows) {
      const orderCol = Object.keys(row).find(k => k.trim().toLowerCase() === 'order #');
      const rateCol  = Object.keys(row).find(k => k.trim().toLowerCase() === 'rate')
                    || Object.keys(row).find(k => k.trim().toLowerCase() === 'shipping paid');
      if (!orderCol || !rateCol) break;
      const num  = normalizeOrderNumber(row[orderCol]);
      const rate = cleanMoney(row[rateCol]);
      if (num && rate !== null) {
        costs.set(num, (costs.get(num) || 0) + rate);
        if (!shipments.has(num)) shipments.set(num, []);
        shipments.get(num).push({ shipmentId: `${num}#${shipments.get(num).length + 1}`, cost: rate });
      }
    }
  }

  // Diagnostics the caller can surface: a shipment with no rate is a gap in the
  // export, not a free label, and must not be read as zero shipping expense.
  let zeroCostShipments = 0, totalShipments = 0;
  for (const list of shipments.values()) {
    for (const sh of list) { totalShipments++; if (!(sh.cost > 0)) zeroCostShipments++; }
  }

  return { costs, apsCosts, shipments,
           costColumnUsed: typeof costColumnUsed === 'undefined' ? 'Rate' : costColumnUsed,
           totalShipments, zeroCostShipments };
}

// ─── HPD Log parser ───────────────────────────────────────────────────────────
// Parses the HPD "Shipping Log Data Extraction" CSV.
// The "Notes - To Buyer" field contains embedded newlines — requires RFC 4180 parser.
// Returns Map<shopifyOrderNum, { hpdOrderNum, shopifyOrderNum, date, carrier, state,
//                                netTerms, prepaid, costDiff, items[] }>
export function parseHpdLog(text) {
  const allRows = _parseRfc4180(text);
  if (allRows.length < 2) return new Map();
  const headers = allRows[0];
  const idxOf = name => headers.findIndex(h => h.trim() === name);

  const iDate     = idxOf('Date - Order Date');
  const iOrder    = idxOf('Order - Number');
  const iCarrier  = idxOf('Carrier - Service Selected');
  const iState    = idxOf('Ship To - State');
  const iQty      = idxOf('Item - Qty');
  const iSku      = idxOf('Item - SKU');
  const iNotes    = idxOf('Notes - From Buyer');
  const iNet      = idxOf('Actual Net Terms Cost (Labor + Carrier Shipping)');
  const iPrepaid  = idxOf('Prepaid Fixed Price');
  const iDiff     = idxOf('Cost Difference (Net Terms - Prepaid)');

  const result = new Map();        // shopifyOrderNum → entry
  const hpdToShopify = new Map();  // hpdOrderNum → shopifyOrderNum

  for (let r = 1; r < allRows.length; r++) {
    const row = allRows[r];
    const hpdOrder = (row[iOrder] || '').trim();
    if (!hpdOrder) continue; // skip summary / total rows

    // Shopify order # is embedded in Notes HTML: <br/>#469322<br/>
    let shopifyNum = hpdToShopify.get(hpdOrder) || '';
    if (!shopifyNum) {
      const notes = row[iNotes] || '';
      const m = notes.match(/#(\d+)/);
      if (m) { shopifyNum = m[1]; hpdToShopify.set(hpdOrder, shopifyNum); }
    }
    if (!shopifyNum) continue;

    const parseMoney = v => {
      const s = (v || '').trim().replace(/[$,]/g, '');
      const n = parseFloat(s);
      return isNaN(n) ? null : n;
    };
    const netTerms = parseMoney(row[iNet]);
    const prepaid  = parseMoney(row[iPrepaid]);
    const costDiff = parseMoney(row[iDiff]);

    if (!result.has(shopifyNum)) {
      result.set(shopifyNum, {
        hpdOrderNum:     hpdOrder,
        shopifyOrderNum: shopifyNum,
        date:    (row[iDate]    || '').trim(),
        carrier: (row[iCarrier] || '').trim(),
        state:   (row[iState]   || '').trim(),
        netTerms: null, prepaid: null, costDiff: null,
        items: [],
      });
    }
    const entry = result.get(shopifyNum);
    // Net Terms appears only on the first item row of each HPD order
    if (entry.netTerms === null && netTerms !== null) {
      entry.netTerms = netTerms;
      entry.prepaid  = prepaid;
      entry.costDiff = costDiff;
    }
    entry.items.push({
      sku: (row[iSku] || '').trim(),
      qty: parseInt(row[iQty] || '1') || 1,
    });
  }

  return result;
}

// RFC 4180 parser: handles quoted fields containing embedded newlines/commas
function _parseRfc4180(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  const t = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inQ) {
      if (ch === '"') {
        if (t[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else { field += ch; }
    } else {
      if      (ch === '"')  { inQ = true; }
      else if (ch === ',')  { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
      else                  { field += ch; }
    }
  }
  row.push(field);
  if (row.some(f => f !== '')) rows.push(row);
  return rows;
}

/**
 * A Succulents Box subscription is charged in full on the order that starts it,
 * so every later delivery arrives as its own order with Lineitem price 0.00 and
 * only a fulfilment cost. Those lines are real COGS against revenue that was
 * already recognised elsewhere — reporting them inside a normal sales channel
 * makes that channel's margin look catastrophic when nothing is wrong.
 *
 * They are therefore bucketed under their own clearly named channel. Their unit
 * economics belong in the Subscriptions and Sub P&L views, which pair each
 * delivery's cost with the monthly price actually charged.
 */
export const SUB_RENEWAL_CHANNEL = 'Subscription renewals (prepaid)';

export const SHIPPING_RULES = Object.freeze({ C3: 'c3', LEGACY: 'legacy' });
export const LIVELY_ROOT_STORE = 'Lively Root';
export const CANCELLED_AFTER_SHIPPING_CATEGORY = 'Cancelled after shipping';

/** Route Shipping Protection line: detected by SKU or by Shopify's product name. */
export function isRouteLine(sku, productName) {
  return /^ROUTEINS/i.test(String(sku || '').trim()) ||
    String(productName || '').toUpperCase().includes('SHIPPING PROTECTION BY ROUTE');
}

const parseShopifyTime = s => {
  const m = String(s || '').trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*([+-]\d{2}:?\d{2}|Z)?$/);
  if (!m) return null;
  const off = !m[3] ? 'Z' : m[3] === 'Z' ? 'Z' : (m[3].includes(':') ? m[3] : `${m[3].slice(0, 3)}:${m[3].slice(3)}`);
  const t = Date.parse(`${m[1]}T${m[2].length === 5 ? m[2] + ':00' : m[2]}${off}`);
  return Number.isNaN(t) ? null : t;
};

/**
 * Evidence that a cancelled order shipped before it was cancelled (C3).
 * Every condition is required; `reason` names the first that fails.
 */
export function cancelledAfterShippingEvidence(row, shipStationCost) {
  if (!row) return { qualifies: false, reason: 'no_order_row' };
  const cancelledAt = parseShopifyTime(row['Cancelled at'] || row['Cancelled At']);
  if (cancelledAt === null) return { qualifies: false, reason: 'not_cancelled' };
  const fulfilledAt = parseShopifyTime(row['Fulfilled at']);
  if (fulfilledAt === null) return { qualifies: false, reason: 'no_fulfilled_at' };
  if (!(fulfilledAt < cancelledAt)) return { qualifies: false, reason: 'fulfilled_after_cancellation' };
  if (!/^(fulfilled|partial)/i.test(String(row['Fulfillment Status'] || '').trim())) return { qualifies: false, reason: 'not_fulfilled' };
  if (!(shipStationCost > 0)) return { qualifies: false, reason: 'no_carrier_cost' };
  const shipping = cleanMoney(row['Shipping']) || 0;
  const kept = Math.round(((cleanMoney(row['Total']) || 0) - (cleanMoney(row['Taxes']) || 0) - (cleanMoney(row['Refunded Amount'] ?? row['Refunded amount']) || 0)) * 100) / 100;
  if (!(shipping > 0) || Math.abs(kept - shipping) > 0.005) return { qualifies: false, reason: 'retained_amount_is_not_the_shipping' };
  return { qualifies: true, reason: null, shipping };
}

function shippingOnlyLine(row, orderNum, evidence, shipStationCosts) {
  const ssRate = shipStationCosts.get(orderNum.replace(/^#/, '')) || null;
  const shipping = evidence.shipping;
  return {
    orderNum, date: (row['Created at'] || '').trim().slice(0, 10), source: normalizeChannel(row['Source name'] || row['Source'] || ''),
    orderCat: CANCELLED_AFTER_SHIPPING_CATEGORY, store: 'Shipping only', vendor: '', sku: '', product: 'Shipping retained after cancellation', qty: 0,
    unitPrice: 0, lineRevenue: 0, orderTotal: shipping, unitCost: 0, costSource: 'Cancelled after shipping (shipping only)', lineCogs: 0,
    lineGp: 0, lineGpPct: null, lineNetGp: 0, lineNetGpPct: null,
    shipCollected: shipping, isFreeShip: '', shipPaid: ssRate, shipPaidSS: ssRate || 0, shipPaidHP: 0,
    shipDelta: ssRate !== null ? Math.round((shipping - ssRate) * 100) / 100 : null, shipNote: 'Cancelled after shipping: customer shipping kept, carrier cost kept',
    shipPaidLR: null, shippingRules: SHIPPING_RULES.C3,
    isInfluencerSample: false, isDigital: false, subMonths: 1, mcgVolDisc: 0, subShipMo: null, expSubShipMo: null, subSSCostMo: null, subShipLoss: null,
    isSubRenewal: false, vendorKey: null, costMatchType: 'shipping_only', missingCost: false, baseMerchRevenue: 0, historicalDiscount: 0,
    refundAllocated: 0, isCancelled: true, isCancelledAfterShipping: true, isShippingOnly: true, isRoute: false, isGiftCard: false,
  };
}

// ─── Main calculation ─────────────────────────────────────────────────────────

export function calculate(orderRows, shipStationCosts, mcgCosts, productCosts, skuWeights, additionalCosts = {}, hpByName = {}, skuAlias = {}, hpdShipCosts = null, mcgExtra = {}, vendorCosts = null, vendorIndex = null, options = {}) {
  const {
    excludeCancelled = true,   // cancelled orders never count toward profitability
    applyRefunds     = true,   // order-level Refunded Amount prorated across lines
    // 'c3' (Revision 9 C3, default): Lively Root pass-through and
    // cancelled-after-shipping retention. 'legacy': the Revision 8 engine,
    // kept for the before/after bridge and the compatibility golden.
    shippingRules    = SHIPPING_RULES.C3,
    // C4a: Map<orderName, amount> of refunds Shopify explicitly attributes to
    // the order's Route line (refund line items naming it). The CSV export has
    // no line-level refunds, so the manual and CSV paths pass nothing and a
    // Route line never receives any part of a general refund.
    routeRefunds     = null,
  } = options;
  if (routeRefunds !== null && !(routeRefunds instanceof Map)) throw new Error('routeRefunds must be a Map');
  if (!Object.values(SHIPPING_RULES).includes(shippingRules)) throw new Error(`Unknown shippingRules ${shippingRules}`);
  const c3 = shippingRules === SHIPPING_RULES.C3;

  // ── Pre-pass 0: cancelled orders + order-level refunds ──
  // Shopify writes 'Cancelled at' and 'Refunded Amount' on the order's first
  // line only, so both are collected per order before the main pass.
  const cancelledOrders = new Set();
  const orderRefunds    = new Map(); // orderNum → refunded $ (order level)
  for (const row of orderRows) {
    const name = (row['Name'] || '').trim();
    if (!name) continue;
    const cancelledAt = (row['Cancelled at'] || row['Cancelled At'] || '').trim();
    if (cancelledAt) cancelledOrders.add(name);
    const refunded = cleanMoney(row['Refunded Amount'] ?? row['Refunded amount']);
    if (refunded !== null && refunded > 0 && !orderRefunds.has(name)) {
      orderRefunds.set(name, refunded);
    }
  }

  // ── Pre-pass: order store composition + HP weight ──
  const orderStores  = new Map(); // orderNum → Set of stores
  const orderShipping = new Map(); // orderNum → customer paid shipping
  const orderHpWeight = new Map(); // orderNum → total HP lb

  for (const row of orderRows) {
    const name = (row['Name'] || '').trim();
    if (!name) continue;
    const sku    = (row['Lineitem sku'] || '').trim();
    const vendor = (row['Vendor'] || '').trim();
    const qtyStr = row['Lineitem quantity'] || '1';
    const qty    = parseInt(qtyStr) || 1;

    if (sku) {
      const store = identifyStore(sku, vendor);
      if (!orderStores.has(name)) orderStores.set(name, new Set());
      orderStores.get(name).add(store);

      if (HP_VENDORS.has(vendor) || store === 'House Plant Dropship') {
        const w = getHpItemWeight(sku, skuWeights);
        orderHpWeight.set(name, (orderHpWeight.get(name) || 0) + w * qty);
      }
    }

    const ship = cleanMoney(row['Shipping']);
    if (ship !== null) orderShipping.set(name, ship);
  }

  // ── Pre-pass 2: total line revenue per order (for shipping proration in mixed orders) ──
  const orderRevTotals = new Map(); // orderNum → sum of all line revenues
  for (const row of orderRows) {
    const name = (row['Name'] || '').trim();
    const sku  = (row['Lineitem sku'] || '').trim();
    if (!name || !sku || sku.toLowerCase() === 'nan') continue;
    const unitPrice = cleanMoney(row['Lineitem price']) || 0;
    const lineDisc  = cleanMoney(row['Lineitem discount']) || 0;
    const qty       = parseInt(row['Lineitem quantity'] || '1') || 1;
    const lineRev   = Math.max(0, Math.round((unitPrice * qty - lineDisc) * 100) / 100);
    orderRevTotals.set(name, (orderRevTotals.get(name) || 0) + lineRev);
  }

  // ── Pre-pass 3: count MCG plant units per order (for volume discount) ──
  const orderMcgPlants = new Map(); // orderNum → total plant units
  for (const row of orderRows) {
    const name = (row['Name'] || '').trim();
    const sku  = (row['Lineitem sku'] || '').trim();
    const qty  = parseInt(row['Lineitem quantity'] || '1') || 1;
    if (!name || !sku || sku.toLowerCase() === 'nan') continue;
    const units = mcgPlantUnits(sku, qty);
    if (units > 0) orderMcgPlants.set(name, (orderMcgPlants.get(name) || 0) + units);
  }

  // ── Detect influencer/sample orders (TikTok free samples gifted to creators) ──
  const influencerOrders = new Set();
  for (const row of orderRows) {
    const name        = (row['Name'] || '').trim();
    const rawTotal    = cleanMoney(row['Total']) || 0;
    const rawSubtotal = cleanMoney(row['Subtotal']) || 0;
    const discCode    = (row['Discount Code'] || '').toLowerCase();
    const tags        = (row['Tags'] || '').toLowerCase();
    const sourceName  = normalizeChannel(row['Source name'] || row['Source'] || '').toLowerCase();
    const noteAttrPre = (row['Note Attributes'] || row['Note attributes'] || '').toLowerCase();
    if (
      discCode.includes('sample') || discCode.includes('influencer') ||
      tags.includes('sample')     || tags.includes('influencer') ||
      noteAttrPre.includes('free sample') ||               // Sellbrite: "Free sample: $28.86"
      (sourceName.includes('tiktok') && rawTotal === 0) ||
      (rawTotal === 0 && rawSubtotal > 0)
    ) {
      influencerOrders.add(name);
    }
  }

  function getOrderCategory(orderNum) {
    const stores = orderStores.get(orderNum) || new Set();
    const hasHp    = [...stores].some(s => HP_VENDORS.has(s) || s === 'House Plant Dropship');
    const has17381 = stores.has('Succulents Box (17381)');
    const hasFree  = stores.has('Air Plant Shop') || stores.has('Live to Give');
    if (has17381 && hasHp)  return 'Mixed (17381 + HP Dropship)';
    if (has17381 && hasFree) return 'Mixed (17381 + Free Ship)';
    if (hasHp && hasFree)   return 'Mixed (HP + Free Ship)';
    if (has17381)           return 'Pure 17381';
    if (hasHp)              return 'Pure HP Dropship';
    if (hasFree)            return 'Pure Free Ship';
    return 'Other';
  }

  // ── C3: Lively Root (Shopify Collective) pass-through ──
  // Succulents Box never ships or pays for Lively Root shipments: the customer's
  // shipping is passed to Lively Root, so collected = expense and net = 0. Only
  // orders whose physical items are ALL Lively Root qualify (Route protection
  // may ride along); a mix with another shipped vendor cannot be split from
  // Shopify's single order-level shipping amount and is left unchanged.
  const lrPassThrough = new Set();
  if (c3) for (const [name, stores] of orderStores) {
    if (stores.has(LIVELY_ROOT_STORE) && [...stores].every(st => st === LIVELY_ROOT_STORE || st === 'Route')) lrPassThrough.add(name);
  }

  // ── C3: cancelled after shipping ──
  // Normally a cancelled order is excluded entirely. When Shopify shows the
  // order was fulfilled BEFORE it was cancelled, a ShipStation cost exists, and
  // everything except the shipping was refunded, the customer-paid shipping and
  // the actual carrier cost are kept as a shipping-only result. The final
  // cancellation flag alone is never taken as evidence of shipment.
  const cancelledAfterShipping = new Map();   // orderNum → { shipping }
  if (c3 && excludeCancelled) {
    const firstRow = new Map();
    for (const row of orderRows) { const n = (row['Name'] || '').trim(); if (n && !firstRow.has(n)) firstRow.set(n, row); }
    for (const name of cancelledOrders) {
      const e = cancelledAfterShippingEvidence(firstRow.get(name), shipStationCosts.get(name.replace(/^#/, '')));
      if (e.qualifies) cancelledAfterShipping.set(name, e);
    }
  }

  // ── Main pass ──
  const lineItems = [];
  const orderSeen = new Set();

  for (const row of orderRows) {
    const orderNum = (row['Name'] || '').trim();
    const sku      = (row['Lineitem sku'] || '').trim();
    if (!sku || sku.toLowerCase() === 'nan') continue;
    // Cancelled orders are excluded from profitability results entirely.
    if (excludeCancelled && cancelledOrders.has(orderNum)) {
      const cas = cancelledAfterShipping.get(orderNum);
      if (cas && !orderSeen.has(orderNum)) { lineItems.push(shippingOnlyLine(row, orderNum, cas, shipStationCosts)); orderSeen.add(orderNum); }
      continue;
    }

    const vendor   = (row['Vendor'] || '').trim();
    const product  = (row['Lineitem name'] || '').trim().slice(0, 100);
    // Note Attributes column contains "Channel: amazon", "Channel: Facebook" etc.
    // for orders imported via Sellbrite. Use that as the source of truth for channel.
    const rawSrc   = row['Source name'] || row['Source'] || '';
    const noteAttr = row['Note Attributes'] || row['Note attributes'] || '';
    const chanMatch   = noteAttr.match(/Channel:\s*([^\n,;|]+)/i);
    const noteChannel = chanMatch ? chanMatch[1].trim() : '';
    const source      = normalizeChannel(noteChannel || rawSrc);
    const date     = (row['Created at'] || '').trim().slice(0, 10);
    const qty      = parseInt(row['Lineitem quantity'] || '1') || 1;
    const unitPrice     = cleanMoney(row['Lineitem price']) || 0;
    const lineDiscount  = cleanMoney(row['Lineitem discount']) || 0;
    const subtotal      = cleanMoney(row['Subtotal']) || 0;
    // Subscription SKUs charge shipping for ALL months upfront (e.g. SUB5-1-12 → 12×$6.99=$83.88).
    // Divide by months so we compare per-delivery shipping against ShipStation's per-shipment rate.
    const subMonths     = getSubMonths(sku);
    const custShipping  = Math.round((cleanMoney(row['Shipping']) || 0) / subMonths * 100) / 100;
    const store         = identifyStore(sku, vendor);
    const orderCat      = getOrderCategory(orderNum);
    const isFirstRow    = !orderSeen.has(orderNum);
    const orderNumClean = orderNum.replace(/^#/, '');
    const ssRate        = shipStationCosts.get(orderNumClean) || null;

    // Expected monthly shipping fee for subscription SKUs (rates effective until Jul 2026)
    const SUB_SHIP_NORMAL = 6.99;
    const SUB_SHIP_POT    = 7.99;

    // For subscription SKUs: compute per-month shipping allocated to this line,
    // prorated by this line's revenue share of the order total.
    // This correctly handles mixed orders (sub + regular items) where the full
    // order shipping would otherwise be mis-attributed to the subscription.
    const isSubSku = /^(SUB|GSUB)/i.test(sku);
    let subShipMo = null, expSubShipMo = null, subSSCostMo = null, subShipLoss = null;
    if (isSubSku) {
      const rawOrderShip  = cleanMoney(row['Shipping']) || 0;
      const orderRevTotal = orderRevTotals.get(orderNum) || 1;
      const thisLineRev   = Math.max(0, Math.round(((cleanMoney(row['Lineitem price']) || 0) * qty
                              - (cleanMoney(row['Lineitem discount']) || 0)) * 100) / 100);
      const revShare      = orderRevTotal > 0 ? Math.min(thisLineRev / orderRevTotal, 1) : 1;
      subShipMo           = Math.round(rawOrderShip * revShare / subMonths * 100) / 100;

      // Expected rate: $7.99 if clay pot upgrade, $6.99 for normal
      const skuUp  = sku.toUpperCase();
      expSubShipMo = (skuUp.includes('POT') || skuUp.includes('UPGRADE'))
                       ? SUB_SHIP_POT : SUB_SHIP_NORMAL;

      // Actual ShipStation cost per month (prorated for mixed orders)
      if (ssRate !== null) {
        // SS charges per shipment; each sub box is its own label — no revShare, no /subMonths
        subSSCostMo = Math.round(ssRate * 100) / 100;
        // Ship loss = SS cost/mo − collected/mo (positive → paying more than collecting)
        subShipLoss = Math.round((subSSCostMo - subShipMo) * 100) / 100;
      }
    }

    // Order total = Shopify Total minus taxes (taxes are pass-through, not revenue)
    const orderTax    = isFirstRow ? (cleanMoney(row['Taxes']) || 0) : 0;
    const orderTotal  = isFirstRow ? Math.round(((cleanMoney(row['Total']) || 0) - orderTax) * 100) / 100 : 0;
    const isInfluencerSample = influencerOrders.has(orderNum);
    // Influencer/sample gifts: force revenue to $0 (order-level discount not in Lineitem discount).
    // Subscription SKUs: keep FULL pre-collected revenue (what the customer actually paid).
    const lineRevenue = isInfluencerSample
      ? 0
      : Math.round((unitPrice * qty - lineDiscount) * 100) / 100;
    let [unitCost, costSource, costMatchType] = getCost(sku, vendor, mcgCosts, productCosts, additionalCosts, hpByName, product, skuAlias, mcgExtra, vendorCosts, vendorIndex);
    costMatchType = costMatchType || labelToMatchType(costSource);
    const vendorKey = inferVendorKey(sku, vendor);
    const productUp = (product || '').toUpperCase();
    const isDigital = costSource === 'Printable (no COGS)' ||
                      productUp.includes('PRINTABLE') ||
                      productUp.includes('COLORING BOOK') ||
                      productUp.includes('DIGITAL DOWNLOAD') ||
                      productUp.includes('E-BOOK') ||
                      /^(DIGITAL|PRINTABLE|EBOOK)/i.test(sku);
    // Route insurance — pass-through: cost = what customer paid, GP = $0
    const isRoute = isRouteLine(sku, product);
    if (isRoute) {
      unitCost   = unitPrice;
      costSource = 'Route (pass-through)';
    }
    // MCG volume discount — reduces per-plant fulfillment cost based on plants/order
    let mcgVolDisc = 0;
    if (unitCost !== null && !isRoute) {
      const orderPlantTotal = orderMcgPlants.get(orderNum) || 0;
      const discPerPlant    = getMcgVolumeDisc(orderPlantTotal);
      if (discPerPlant > 0) {
        const plantsPerUnit = mcgPlantUnits(sku, 1); // plants in 1 unit of this SKU
        if (plantsPerUnit > 0) {
          mcgVolDisc = Math.round(discPerPlant * plantsPerUnit * qty * 100) / 100;
          unitCost   = Math.round((unitCost - discPerPlant * plantsPerUnit) * 100) / 100;
          costSource += ` (−$${discPerPlant}/plant vol disc, ${orderPlantTotal} plants)`;
        }
      }
    }
    // getCost() returns per-delivery cost for SUB/GSUB ($3/plant/mo).
    // Use first delivery only — future months have no matching revenue in this view.
    const lineCogs = unitCost !== null ? Math.round(unitCost * qty * 100) / 100 : null;
    // A prepaid subscription delivery: subscription SKU, no revenue on this
    // order, but a real fulfilment cost. Revenue for it was collected upfront on
    // the order that started the subscription.
    const isSubRenewal = isSubSku && lineRevenue === 0 && lineCogs !== null && lineCogs > 0;
    const lineGp   = lineCogs !== null ? Math.round((lineRevenue - lineCogs) * 100) / 100 : null;
    const lineGpPct = (lineGp !== null && lineRevenue !== 0)
      ? Math.round(lineGp / lineRevenue * 1000) / 10 : null;

    // Shipping (order-level, first row only)
    let shipCollected = null, shipPaid = null, shipDelta = null, shipNote = null;
    let shipPaidSS = null, shipPaidHP = null, shipPaidLR = null;
    let isFreeShip = '';

    if (isFirstRow) {
      shipCollected = custShipping;
      isFreeShip = custShipping === 0 ? 'YES' : '';

      if (orderCat === 'Pure HP Dropship') {
        // House Plant Dropship shipping is passed through to the customer:
        // expense = what the customer paid, contribution = 0. No ShipStation
        // match is required, and the expense is never estimated from weight.
        const hpdEntry = hpdShipCosts ? hpdShipCosts.get(orderNumClean) : null;
        if (hpdEntry && hpdEntry.netTerms !== null) {
          // The HPD log gives the precise actual cost — more accurate than the
          // pass-through assumption, so it wins when present.
          shipPaid  = hpdEntry.netTerms;
          shipPaidSS = 0; shipPaidHP = hpdEntry.netTerms;
          shipDelta = Math.round((custShipping - hpdEntry.netTerms) * 100) / 100;
          shipNote  = `HPD actual (${hpdEntry.hpdOrderNum})`;
        } else {
          shipPaid  = custShipping;
          shipPaidSS = 0; shipPaidHP = custShipping;
          shipDelta = 0;
          shipNote  = 'HPD pass-through (Shopify shipping)';
        }

      } else if (orderCat === 'Pure 17381') {
        shipPaid  = ssRate;
        shipPaidSS = ssRate || 0; shipPaidHP = 0;
        shipDelta = ssRate !== null ? Math.round((custShipping - ssRate) * 100) / 100 : null;
        shipNote  = 'ShipStation';

      } else if (orderCat === 'Pure Free Ship') {
        shipPaid  = ssRate;
        shipPaidSS = ssRate || 0; shipPaidHP = 0;
        shipDelta = ssRate !== null ? Math.round((custShipping - ssRate) * 100) / 100 : null;
        shipNote  = ssRate !== null ? 'ShipStation (free to customer)' : 'ShipStation (no rate found)';

      } else if (orderCat === 'Mixed (17381 + HP Dropship)' ||
                 orderCat === 'Mixed (HP + Free Ship)') {
        // Mixed HPD shipping. The non-HPD shipment's expense is the actual
        // deduplicated ShipStation cost. Shopify only reports one combined
        // order-level shipping amount, so the HPD portion is the conservative
        // remainder of what the customer paid (never negative), unless the HPD
        // log gives the precise component.
        const hpdEntry = hpdShipCosts ? hpdShipCosts.get(orderNumClean) : null;
        const nonHpd   = ssRate || 0;
        const hpdPass  = (hpdEntry && hpdEntry.netTerms !== null)
          ? hpdEntry.netTerms
          : Math.max(0, Math.round((custShipping - nonHpd) * 100) / 100);
        shipPaidSS = nonHpd; shipPaidHP = hpdPass;
        shipPaid   = Math.round((nonHpd + hpdPass) * 100) / 100;
        shipDelta  = Math.round((custShipping - shipPaid) * 100) / 100;
        shipNote   = (hpdEntry && hpdEntry.netTerms !== null)
          ? `Mixed HPD shipping (SS $${nonHpd.toFixed(2)} + HPD actual $${hpdPass.toFixed(2)})`
          : `Mixed HPD shipping (SS $${nonHpd.toFixed(2)} + HPD pass-through $${hpdPass.toFixed(2)})`;

      } else if (lrPassThrough.has(orderNum)) {
        // C3: Lively Root ships and charges; Succulents Box passes the customer's
        // shipping through. A ShipStation cost is not used unless a verified
        // source shows Succulents Box bought that label.
        shipPaid   = custShipping;
        shipPaidSS = 0; shipPaidHP = 0; shipPaidLR = custShipping;
        shipDelta  = 0;
        shipNote   = ssRate !== null ? 'Lively Root pass-through (ShipStation cost present, not used)' : 'Lively Root pass-through (Shopify Collective)';

      } else {
        shipPaid  = ssRate;
        shipPaidSS = ssRate || 0; shipPaidHP = 0;
        shipDelta = ssRate !== null ? Math.round((custShipping - ssRate) * 100) / 100 : null;
        shipNote  = orderCat;
      }
    }

    // Net GP — set to GP$ initially; post-pass below prorates actual shipDelta across lines
    const lineNetGp = lineGp;
    const lineNetGpPct = (lineNetGp !== null && lineRevenue !== 0)
      ? Math.round(lineNetGp / lineRevenue * 1000) / 10 : null;

    lineItems.push({
      orderNum, date, source, orderCat: isFirstRow ? orderCat : null,
      store, vendor, sku, product, qty,
      unitPrice, lineRevenue, orderTotal, unitCost, costSource, lineCogs, lineGp, lineGpPct,
      lineNetGp, lineNetGpPct,
      shipCollected, isFreeShip, shipPaid, shipPaidSS, shipPaidHP, shipDelta, shipNote,
      ...(c3 ? { shipPaidLR, shippingRules } : {}),
      isInfluencerSample, isDigital, subMonths, mcgVolDisc, subShipMo, expSubShipMo, subSSCostMo, subShipLoss,
      isSubRenewal,
      // ── Audit trail carried on every calculated line ──
      vendorKey,                              // catalog vendor this line resolved against
      costMatchType,                          // how the cost was matched
      missingCost: unitCost === null,         // never treat a missing cost as zero
      baseMerchRevenue: Math.round(unitPrice * qty * 100) / 100,
      historicalDiscount: Math.round(Math.max(0, unitPrice * qty - lineRevenue) * 100) / 100,
      refundAllocated: 0,                     // filled in by the refund post-pass
      isCancelled: cancelledOrders.has(orderNum),
      isRoute, isGiftCard: costSource === 'Gift Card (no COGS)',
    });

    orderSeen.add(orderNum);
  }

  // ── Post-pass: order-level refunds ──
  // The Shopify export gives only an order-level 'Refunded Amount'. It is
  // prorated across the order's eligible product lines by each line's actual
  // net product revenue share, capped at that line's revenue so a refund can
  // never push a line negative. Line-level revenue in the export is NOT
  // refund-adjusted, so there is no double counting. Any part of the refund
  // that exceeds product revenue (refunded shipping, tax, or an unattributed
  // amount) is recorded separately rather than silently absorbed into product
  // margin.
  //
  // C4a: Route Shipping Protection lines are never eligible for the prorated
  // share — a general refund is not evidence that Route was refunded. A Route
  // refund is recognised only when Shopify explicitly identifies the Route line
  // (`routeRefunds`); it then reduces both the Route amount collected and the
  // pass-through amount remitted, so Route stays at zero contribution.
  if (applyRefunds && orderRefunds.size) {
    const byOrder = new Map();
    for (const li of lineItems) {
      if (!byOrder.has(li.orderNum)) byOrder.set(li.orderNum, []);
      byOrder.get(li.orderNum).push(li);
    }
    for (const [orderNum, refund] of orderRefunds) {
      // A cancelled-after-shipping result already nets the refund: only the
      // retained customer shipping is revenue (evidence required it to equal
      // Total − Taxes − Refunded).
      if (cancelledAfterShipping.has(orderNum)) continue;
      const lines = byOrder.get(orderNum);
      if (!lines || !lines.length) continue;

      // Explicit Route refund (Shopify refund line on the Route line) only.
      const routeLines = lines.filter(l => l.isRoute && (l.lineRevenue || 0) > 0);
      const routeRev = Math.round(routeLines.reduce((s, l) => s + l.lineRevenue, 0) * 100) / 100;
      const explicitRoute = Math.round(Math.max(0, Math.min(
        routeRefunds ? (Number(routeRefunds.get(orderNum)) || 0) : 0, refund, routeRev)) * 100) / 100;
      let routeAllocated = 0;
      routeLines.forEach((li, i) => {
        if (!(explicitRoute > 0)) return;
        const isLast = i === routeLines.length - 1;
        const share  = isLast
          ? Math.round((explicitRoute - routeAllocated) * 100) / 100
          : Math.round(explicitRoute * (li.lineRevenue / routeRev) * 100) / 100;
        routeAllocated = Math.round((routeAllocated + share) * 100) / 100;
        li.refundAllocated = share;
        li.routeRefundSource = 'shopify_refund_line';
        li.lineRevenue = Math.round((li.lineRevenue - share) * 100) / 100;
        // Pass-through: a refunded Route amount is not remitted either.
        if (li.lineCogs !== null) li.lineCogs = Math.round((li.lineCogs - share) * 100) / 100;
        li.lineGp = li.lineCogs !== null
          ? Math.round((li.lineRevenue - li.lineCogs) * 100) / 100 : null;
        li.lineGpPct = (li.lineGp !== null && li.lineRevenue !== 0)
          ? Math.round(li.lineGp / li.lineRevenue * 1000) / 10 : null;
      });

      const generalRefund = Math.round((refund - explicitRoute) * 100) / 100;
      const eligible = lines.filter(l => !l.isRoute && (l.lineRevenue || 0) > 0);
      const totalRev = eligible.reduce((s, l) => s + l.lineRevenue, 0);
      const productRefund = Math.min(generalRefund, totalRev);
      let allocated = 0;
      eligible.forEach((li, i) => {
        const isLast = i === eligible.length - 1;
        const share  = isLast
          ? Math.round((productRefund - allocated) * 100) / 100
          : Math.round(productRefund * (li.lineRevenue / totalRev) * 100) / 100;
        allocated = Math.round((allocated + share) * 100) / 100;
        li.refundAllocated = share;
        li.lineRevenue = Math.round((li.lineRevenue - share) * 100) / 100;
        li.lineGp = li.lineCogs !== null
          ? Math.round((li.lineRevenue - li.lineCogs) * 100) / 100 : null;
        li.lineGpPct = (li.lineGp !== null && li.lineRevenue !== 0)
          ? Math.round(li.lineGp / li.lineRevenue * 1000) / 10 : null;
      });
      const first = lines[0];
      first.orderRefund = refund;
      if (explicitRoute > 0) first.routeRefund = explicitRoute;
      first.refundBeyondProduct = Math.round((generalRefund - productRefund) * 100) / 100;
      if (first.orderTotal) {
        first.orderTotal = Math.round((first.orderTotal - refund) * 100) / 100;
      }
    }
  }

  // ── Post-pass: prorate order-level shipping to every line item by revenue weight ──
  // This makes Net GP meaningful per SKU line, not just the first line of each order.
  const orderGroups = new Map();
  for (let i = 0; i < lineItems.length; i++) {
    const o = lineItems[i].orderNum;
    if (!orderGroups.has(o)) orderGroups.set(o, []);
    orderGroups.get(o).push(i);
  }
  for (const indices of orderGroups.values()) {
    const firstLi = lineItems[indices[0]];
    // If no ShipStation data, shipDelta=0 so Net GP = GP$ (don't leave blank)
    const shipDelta = firstLi.shipDelta ?? 0;
    const totalRev = indices.reduce((sum, i) => sum + (lineItems[i].lineRevenue || 0), 0);
    for (const idx of indices) {
      const li  = lineItems[idx];
      const share = totalRev > 0 ? (li.lineRevenue || 0) / totalRev : 1 / indices.length;
      const alloc = Math.round(shipDelta * share * 100) / 100;
      li.lineNetGp = li.lineGp !== null
        ? Math.round((li.lineGp + alloc) * 100) / 100 : null;
      li.lineNetGpPct = (li.lineNetGp !== null && li.lineRevenue !== 0)
        ? Math.round(li.lineNetGp / li.lineRevenue * 1000) / 10 : null;
    }
  }

  return lineItems;
}

// ─── Aggregation helpers ──────────────────────────────────────────────────────

export function summarize(lineItems) {
  let totalRevenueSrc = 0, productRevenue = 0, totalCogs = 0;
  let totalShipCollected = 0, totalShipPaid = 0;
  let missingCost = 0;
  const byStore = {};
  const byChannel = {};      // channel → { revenue, cogs, gp }
  const byChannelStore = {}; // channel → { store → { revenue, cogs } }
  const shipByType = {};
  // Shipping paid breakdown by vendor
  const shipByVendor = {
    'ShipStation':    { paid: 0, orders: new Set() },
    'HP Dropship':    { paid: 0, orders: new Set() },
    'Lively Root':    { paid: 0, orders: new Set() },   // C3 pass-through (Shopify Collective)
  };

  for (const li of lineItems) {
    totalRevenueSrc += li.orderTotal  || 0;  // sum of Shopify order Totals
    productRevenue  += li.lineRevenue || 0;  // sum of line revenues (for per-line GP table)
    totalCogs       += li.lineCogs   || 0;
    if (li.costSource === 'COST MISSING') missingCost++;

    // By store
    const s = li.store || 'Unknown';
    if (!byStore[s]) byStore[s] = { revenue:0, cogs:0, gp:0, orders:new Set() };
    byStore[s].revenue += li.lineRevenue || 0;
    byStore[s].cogs    += li.lineCogs   || 0;
    byStore[s].orders.add(li.orderNum);

    // By channel. Prepaid subscription deliveries get their own labelled bucket
    // so they never drag a real sales channel's margin negative.
    if (li.source || li.isSubRenewal) {
      const c = li.isSubRenewal ? SUB_RENEWAL_CHANNEL : li.source;
      if (!byChannel[c]) byChannel[c] = { revenue:0, cogs:0, gp:0 };
      byChannel[c].revenue += li.lineRevenue || 0;
      byChannel[c].cogs    += li.lineCogs    || 0;
      // By channel × store
      if (!byChannelStore[c]) byChannelStore[c] = {};
      const st = li.store || 'Unknown';
      if (!byChannelStore[c][st]) byChannelStore[c][st] = { revenue:0, cogs:0 };
      byChannelStore[c][st].revenue += li.lineRevenue || 0;
      byChannelStore[c][st].cogs    += li.lineCogs    || 0;
    }

    // Shipping by order type
    if (li.shipCollected !== null) {
      totalShipCollected += li.shipCollected || 0;
      if (li.shipPaid !== null) totalShipPaid += li.shipPaid;

      const t = li.orderCat || 'Other';
      if (!shipByType[t]) shipByType[t] = { collected:0, paid:0, delta:0, orders:0, noDelta:0 };
      shipByType[t].collected += li.shipCollected || 0;
      if (li.shipPaid !== null)  shipByType[t].paid    += li.shipPaid;
      if (li.shipDelta !== null) shipByType[t].delta   += li.shipDelta;
      else shipByType[t].noDelta++;
      shipByType[t].orders++;

      // Shipping paid by vendor
      if (li.shipPaidSS !== null) {
        shipByVendor['ShipStation'].paid += li.shipPaidSS;
        if (li.shipPaidSS > 0) shipByVendor['ShipStation'].orders.add(li.orderNum);
      }
      if (li.shipPaidHP !== null) {
        shipByVendor['HP Dropship'].paid += li.shipPaidHP;
        if (li.shipPaidHP > 0) shipByVendor['HP Dropship'].orders.add(li.orderNum);
      }
      if (li.shipPaidLR !== null && li.shipPaidLR !== undefined) {
        shipByVendor['Lively Root'].paid += li.shipPaidLR;
        if (li.shipPaidLR > 0) shipByVendor['Lively Root'].orders.add(li.orderNum);
      }
    }
  }

  // Convert Set → count
  for (const s of Object.values(byStore)) s.orders = s.orders.size;
  for (const v of Object.values(shipByVendor)) v.orders = v.orders.size;

  // Total Revenue = sum of Shopify order Totals (already includes shipping collected + taxes)
  // GP = Total Revenue - COGS - Shipping Paid
  const totalRevenue = Math.round(totalRevenueSrc * 100) / 100;
  const totalGp      = Math.round((totalRevenue - totalCogs - totalShipPaid) * 100) / 100;
  const gpPct        = totalRevenue > 0 ? Math.round(totalGp / totalRevenue * 1000) / 10 : 0;

  // Back-fill store/channel GP with the same formula (product only, no shipping split)
  for (const s of Object.values(byStore))   s.gp = Math.round((s.revenue - s.cogs) * 100) / 100;
  for (const c of Object.values(byChannel)) c.gp = Math.round((c.revenue - c.cogs) * 100) / 100;
  for (const ch of Object.values(byChannelStore))
    for (const st of Object.values(ch)) st.gp = Math.round((st.revenue - st.cogs) * 100) / 100;

  return { totalRevenue, productRevenue, totalShipCollected, totalShipPaid,
           totalCogs, totalGp, gpPct, missingCost, byStore, byChannel, byChannelStore, shipByType, shipByVendor };
}
