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
  'pack':       2.00,  // Rack/Pack (RAKN/RAKZ/RAJZ) — $2/plant × count from SKU
};

const MCG_PREFIXES = [
  'S1','S2','S3','SX','C2','C3','CX',
  'EEZZ','EBZZ','EEVZ','PPKZ','PPJZ',
  'RAKN','RAKZ','RAJZ','MODERNPOT','1001','1002','1005','1014',
  '1050','1055','1064','1075','1079','1083','1090','1110',
  '1114','1237','1253','1264','1311','1313','1340','BD-','4X-','E1031',
  'SUB'
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

function identifyStore(sku, vendor) {
  const s = (sku || '').toUpperCase().trim();
  const v = (vendor || '').trim();
  if (s.startsWith('AS-'))           return 'Air Plant Shop';
  if (LIVE_TO_GIVE_PATTERNS.some(p => s.startsWith(p.toUpperCase()))) return 'Live to Give';
  if (s.startsWith('MG-'))           return 'Succulents Box (17381)';
  if (s.startsWith('FH-'))           return 'House Plant Dropship';
  if (s.startsWith('4INSUCCULENTS')) return 'Succulents Box (17381)';
  if (/^\d+$/.test(s))               return 'Unknown (no SKU set)';
  if (HP_VENDORS.has(v))             return v;
  if (v === 'Succulents Box')        return 'Succulents Box (17381)';
  return v || 'Unknown';
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
    // Last two numbers → [plants/mo, months]; if only one → plants only
    const plants = nums.length >= 2 ? nums[nums.length - 2] : (nums[0] || 1);
    const months = nums.length >= 2 ? nums[nums.length - 1] : 1;
    const total  = Math.round(MCG_TIER.sub * plants * months * 100) / 100;
    return [total, `MCG tier (Sub ${plants}×${months}mo)`];
  }
  // 2" pot upgrade: S2/C2 + POT or UPGRADE in SKU
  if ((s.startsWith('S2')||s.startsWith('C2')) && (s.includes('POT')||s.includes('UPGRADE')))
                                                            return [MCG_TIER['2inch_pot'],'MCG tier (2" Pot Upgrade)'];
  // 4" pot upgrade: S3/C3/SX/CX/S1 + POT or UPGRADE in SKU
  if (['S3','C3','SX','CX','S1'].some(p=>s.startsWith(p)) && (s.includes('POT')||s.includes('UPGRADE')))
                                                            return [MCG_TIER['4inch_pot'],'MCG tier (4" Pot Upgrade)'];
  // 2" base
  if (s.startsWith('S2')||s.startsWith('C2')||s.startsWith('E1031'))
                                                            return [MCG_TIER['2inch'],   'MCG tier (2")'];
  // 4" base
  if (['S3','C3','SX','CX','S1'].some(p=>s.startsWith(p))) return [MCG_TIER['4inch'],   'MCG tier (4")'];
  // Rack/Pack: RAKN/RAKZ/RAJZ — $2/plant × count (last numeric segment of SKU)
  // e.g. RAKN2918-6 → 6 plants → $12
  if (s.startsWith('RAKN') || s.startsWith('RAKZ') || s.startsWith('RAJZ')) {
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

function getCost(sku, vendor, mcgCosts, productCosts, additionalCosts) {
  const key = (sku || '').toUpperCase().trim();

  // Composite SKU: "S3KY2997+EEZZ7650" = two products bundled — sum both costs
  if (key.includes('+')) {
    const parts = key.split('+').map(p => p.trim()).filter(Boolean);
    let total = 0;
    const labels = [];
    for (const part of parts) {
      const [c, l] = getCost(part, vendor, mcgCosts, productCosts, additionalCosts);
      if (c === null) return [null, 'COST MISSING'];
      total += c;
      labels.push(`${part}:${l}`);
    }
    return [Math.round(total * 100) / 100, 'Bundle (' + labels.join(' + ') + ')'];
  }

  // 1. MCG Total sheet has the exact cost — always wins
  if (mcgCosts[key] !== undefined)     return [mcgCosts[key],     'MCG Total sheet'];
  // 2. HP/product costs baked in at deploy time
  if (productCosts[key] !== undefined) return [productCosts[key], 'Products export'];
  // 3. Manually uploaded costs CSV
  if (additionalCosts && additionalCosts[key] !== undefined) return [additionalCosts[key], 'Manual costs'];
  // 4. MCG tier fallback — only for SKUs that look like MCG but aren't in Total sheet yet
  if (isMcgSku(sku)) {
    const [cost, label] = mcgTierCost(sku, mcgCosts);
    if (cost !== null) return [cost, label];
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
  // Returns Map: orderNum (no #) → total shipping cost
  const costs = new Map();
  for (const row of rows) {
    const orderCol = Object.keys(row).find(k => k.trim().toLowerCase() === 'order #');
    const rateCol  = Object.keys(row).find(k => k.trim().toLowerCase() === 'rate');
    if (!orderCol || !rateCol) break;
    const num  = (row[orderCol] || '').trim().replace(/^#/, '');
    const rate = cleanMoney(row[rateCol]);
    if (num && rate !== null) {
      costs.set(num, (costs.get(num) || 0) + rate);
    }
  }
  return costs;
}

// ─── Main calculation ─────────────────────────────────────────────────────────

export function calculate(orderRows, shipStationCosts, mcgCosts, productCosts, skuWeights, additionalCosts = {}) {
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
    const source   = (row['Source'] || '').trim();
    const date     = (row['Created at'] || '').trim().slice(0, 10);
    const qty      = parseInt(row['Lineitem quantity'] || '1') || 1;
    const unitPrice     = cleanMoney(row['Lineitem price']) || 0;
    const lineDiscount  = cleanMoney(row['Lineitem discount']) || 0;
    const subtotal      = cleanMoney(row['Subtotal']) || 0;
    const custShipping  = cleanMoney(row['Shipping']) || 0;
    const store         = identifyStore(sku, vendor);
    const orderCat      = getOrderCategory(orderNum);
    const isFirstRow    = !orderSeen.has(orderNum);
    const orderNumClean = orderNum.replace(/^#/, '');
    const ssRate        = shipStationCosts.get(orderNumClean) || null;

    // Order total = Shopify Total minus taxes (taxes are pass-through, not revenue)
    const orderTax    = isFirstRow ? (cleanMoney(row['Taxes']) || 0) : 0;
    const orderTotal  = isFirstRow ? Math.round(((cleanMoney(row['Total']) || 0) - orderTax) * 100) / 100 : 0;
    const lineRevenue = Math.round((unitPrice * qty - lineDiscount) * 100) / 100;  // per-line revenue after discount
    const [unitCost, costSource] = getCost(sku, vendor, mcgCosts, productCosts, additionalCosts);
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
        shipPaid  = hpRate;
        shipPaidSS = 0; shipPaidHP = hpRate;
        shipDelta = Math.round((custShipping - hpRate) * 100) / 100;
        shipNote  = `HP pass-through (${hpW.toFixed(2)}lb)`;

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

    lineItems.push({
      orderNum, date, source, orderCat: isFirstRow ? orderCat : null,
      store, vendor, sku, product, qty,
      unitPrice, lineRevenue, orderTotal, unitCost, costSource, lineCogs, lineGp, lineGpPct,
      shipCollected, isFreeShip, shipPaid, shipPaidSS, shipPaidHP, shipDelta, shipNote
    });

    orderSeen.add(orderNum);
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
