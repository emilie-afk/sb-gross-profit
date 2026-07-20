/**
 * GP Calculator — JavaScript port of calculate_gp.py
 * All data stays in the browser. No network requests.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

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
  'RAKN','RAKZ','RAJZ','RAJN','MODERNPOT','1001','1002','1005','1014',
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

function getCost(sku, vendor, mcgCosts, productCosts, additionalCosts, hpByName, productName, skuAlias = {}) {
  const key = (sku || '').toUpperCase().trim();

  // Composite SKU: "S3KY2997+EEZZ7650" = two products bundled — sum both costs
  if (key.includes('+')) {
    const parts = key.split('+').map(p => p.trim()).filter(Boolean);
    let total = 0;
    const labels = [];
    for (const part of parts) {
      const [c, l] = getCost(part, vendor, mcgCosts, productCosts, additionalCosts, hpByName, null, skuAlias);
      if (c === null) return [null, 'COST MISSING'];
      total += c;
      labels.push(`${part}:${l}`);
    }
    return [Math.round(total * 100) / 100, 'Bundle (' + labels.join(' + ') + ')'];
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
  {
    const nameU = (productName || '').toUpperCase();
    if (key.includes('RANDOM') ||
        nameU.includes('RANDOM') ||
        nameU.includes('SUCCULENT PACK')) {
      return [2.00, 'Random/Pack succulent ($2)'];
    }
  }

  // 1. MCG Total sheet has the exact cost — always wins
  if (mcgCosts[key] !== undefined)     return [mcgCosts[key],     'MCG Total sheet'];
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
  // 4. MCG tier fallback — only for SKUs that look like MCG but aren't in Total sheet yet
  if (isMcgSku(sku)) {
    const [cost, label] = mcgTierCost(sku, mcgCosts);
    if (cost !== null) return [cost, label];
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
    return getCost(canonical, vendor, mcgCosts, productCosts, additionalCosts, hpByName, productName, {});
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
  return [null, 'COST MISSING'];
}

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

export function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const headers = parseCSVRow(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = parseCSVRow(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = vals[idx] || ''; });
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

export function parseShipStation(rows) {
  // Returns { costs: Map<orderNum, totalRate>, apsCosts: Map<orderNum, apsRate> }
  // Auto-detects "line items" format (has 'Shipment #' column) vs summary format.
  // Line items format: Rate repeats per line within a shipment → dedupe by Shipment #.
  // apsCosts is populated only in line items format (APS shipments identified by AS- SKU prefix).
  const costs    = new Map();
  const apsCosts = new Map();

  if (!rows.length) return { costs, apsCosts };

  const isLineItems = Object.keys(rows[0]).some(k => k.trim() === 'Shipment #');

  if (isLineItems) {
    // Pass 1: collect rate + APS flag per shipment
    const shipRate = new Map();  // shipmentId → { rate, orderNum }
    const shipHasAps = new Map(); // shipmentId → bool

    for (const row of rows) {
      const shipId   = (row['Shipment #'] || '').trim();
      const orderNum = (row['Order #']    || '').trim().replace(/^#/, '');
      const rate     = cleanMoney(row['Rate'] || '') || 0;
      const sku      = (row['Item SKU']   || '').trim();
      if (!shipId || !orderNum) continue;
      if (!shipRate.has(shipId)) shipRate.set(shipId, { rate, orderNum });
      if (sku.startsWith('AS-')) shipHasAps.set(shipId, true);
    }

    // Pass 2: accumulate per order
    for (const [shipId, { rate, orderNum }] of shipRate) {
      costs.set(orderNum, (costs.get(orderNum) || 0) + rate);
      if (shipHasAps.get(shipId)) {
        apsCosts.set(orderNum, (apsCosts.get(orderNum) || 0) + rate);
      }
    }
  } else {
    // Original summary format: one effective row per order
    for (const row of rows) {
      const orderCol = Object.keys(row).find(k => k.trim().toLowerCase() === 'order #');
      const rateCol  = Object.keys(row).find(k => k.trim().toLowerCase() === 'rate');
      if (!orderCol || !rateCol) break;
      const num  = (row[orderCol] || '').trim().replace(/^#/, '');
      const rate = cleanMoney(row[rateCol]);
      if (num && rate !== null) costs.set(num, (costs.get(num) || 0) + rate);
    }
  }

  return { costs, apsCosts };
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

// ─── Main calculation ─────────────────────────────────────────────────────────

export function calculate(orderRows, shipStationCosts, mcgCosts, productCosts, skuWeights, additionalCosts = {}, hpByName = {}, skuAlias = {}, hpdShipCosts = null) {
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

  // ── Main pass ──
  const lineItems = [];
  const orderSeen = new Set();

  for (const row of orderRows) {
    const orderNum = (row['Name'] || '').trim();
    const sku      = (row['Lineitem sku'] || '').trim();
    if (!sku || sku.toLowerCase() === 'nan') continue;

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

    // Order total = Shopify Total minus taxes (taxes are pass-through, not revenue)
    const orderTax    = isFirstRow ? (cleanMoney(row['Taxes']) || 0) : 0;
    const orderTotal  = isFirstRow ? Math.round(((cleanMoney(row['Total']) || 0) - orderTax) * 100) / 100 : 0;
    const isInfluencerSample = influencerOrders.has(orderNum);
    // Influencer/sample gifts: force revenue to $0 (order-level discount not in Lineitem discount).
    // Subscription SKUs: keep FULL pre-collected revenue (what the customer actually paid).
    const lineRevenue = isInfluencerSample
      ? 0
      : Math.round((unitPrice * qty - lineDiscount) * 100) / 100;
    let [unitCost, costSource] = getCost(sku, vendor, mcgCosts, productCosts, additionalCosts, hpByName, product, skuAlias);
    // Route insurance — pass-through: cost = what customer paid, GP = $0
    if (/^ROUTEINS/i.test(sku) ||
        (product || '').toUpperCase().includes('SHIPPING PROTECTION BY ROUTE')) {
      unitCost   = unitPrice;
      costSource = 'Route (pass-through)';
    }
    // getCost() returns per-delivery cost for SUB/GSUB ($3/plant/mo).
    // Use first delivery only — future months have no matching revenue in this view.
    const lineCogs = unitCost !== null ? Math.round(unitCost * qty * 100) / 100 : null;
    const lineGp   = lineCogs !== null ? Math.round((lineRevenue - lineCogs) * 100) / 100 : null;
    const lineGpPct = (lineGp !== null && lineRevenue !== 0)
      ? Math.round(lineGp / lineRevenue * 1000) / 10 : null;

    // Shipping (order-level, first row only)
    let shipCollected = null, shipPaid = null, shipDelta = null, shipNote = null;
    let shipPaidSS = null, shipPaidHP = null;
    let isFreeShip = '';

    if (isFirstRow) {
      shipCollected = custShipping;
      isFreeShip = custShipping === 0 ? 'YES' : '';

      if (orderCat === 'Pure HP Dropship') {
        const hpW    = orderHpWeight.get(orderNum) || 0;
        const hpRate = hpW > 0 ? hpShipRate(hpW) : custShipping;
        const hpdEntry = hpdShipCosts ? hpdShipCosts.get(orderNumClean) : null;
        if (hpdEntry && hpdEntry.netTerms !== null) {
          // Actual HPD cost from log file — overrides weight-based estimate
          shipPaid  = hpdEntry.netTerms;
          shipPaidSS = 0; shipPaidHP = hpdEntry.netTerms;
          shipDelta = Math.round((custShipping - hpdEntry.netTerms) * 100) / 100;
          shipNote  = `HPD actual (${hpdEntry.hpdOrderNum})`;
        } else {
          shipPaid  = hpRate;
          shipPaidSS = 0; shipPaidHP = hpRate;
          shipDelta = Math.round((custShipping - hpRate) * 100) / 100;
          shipNote  = `HP est (${hpW.toFixed(2)}lb)`;
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

      } else if (orderCat === 'Mixed (17381 + HP Dropship)') {
        const hpW    = orderHpWeight.get(orderNum) || 0;
        const hpRate = hpShipRate(hpW);
        shipPaidSS = ssRate || 0; shipPaidHP = hpRate;
        shipPaid  = Math.round((shipPaidSS + hpRate) * 100) / 100;
        shipDelta = ssRate !== null
          ? Math.round((custShipping - hpRate - ssRate) * 100) / 100 : null;
        shipNote  = `17381:ShipStation + HP:${hpW.toFixed(2)}lb=$${hpRate.toFixed(2)}`;

      } else if (orderCat === 'Mixed (HP + Free Ship)') {
        const hpW    = orderHpWeight.get(orderNum) || 0;
        const hpRate = hpShipRate(hpW);
        shipPaidSS = ssRate || 0; shipPaidHP = hpRate;
        shipPaid  = Math.round((shipPaidSS + hpRate) * 100) / 100;
        shipDelta = ssRate !== null
          ? Math.round((custShipping - hpRate - ssRate) * 100) / 100 : null;
        shipNote  = `SS + HP:${hpW.toFixed(2)}lb=$${hpRate.toFixed(2)}`;

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
      isInfluencerSample, subMonths,
    });

    orderSeen.add(orderNum);
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
  const byChannel = {};
  const shipByType = {};
  // Shipping paid breakdown by vendor
  const shipByVendor = {
    'ShipStation':    { paid: 0, orders: new Set() },
    'HP Dropship':    { paid: 0, orders: new Set() },
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

    // By channel
    if (li.source) {
      const c = li.source;
      if (!byChannel[c]) byChannel[c] = { revenue:0, gp:0 };
      byChannel[c].revenue += li.lineRevenue || 0;
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
  for (const c of Object.values(byChannel)) c.gp = Math.round((c.revenue - (byChannel[c]?.cogs||0)) * 100) / 100;

  return { totalRevenue, productRevenue, totalShipCollected, totalShipPaid,
           totalCogs, totalGp, gpPct, missingCost, byStore, byChannel, shipByType, shipByVendor };
}
