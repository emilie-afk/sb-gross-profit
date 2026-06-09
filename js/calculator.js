/**
 * GP Calculator — JavaScript port of calculate_gp.py
 * All data stays in the browser. No network requests.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const MCG_TIER = { '2inch': 4.00, '4inch': 6.00, 'sub': 3.00 };

const MCG_PREFIXES = [
  'S1','S2','S3','SX','C2','C3','CX',
  'EEZZ','EBZZ','EEVZ','PPKZ','PPJZ',
  'RAKN','RAJZ','MODERNPOT','1001','1002','1005','1014',
  '1050','1055','1064','1075','1079','1083','1090','1110',
  '1114','1237','1253','1264','1311','1313','1340','BD-','4X-','E1031'
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

function mcgTierCost(sku) {
  const s = sku.toUpperCase();
  if (s.startsWith('SUB'))                                  return [MCG_TIER.sub,   'MCG tier (subscription)'];
  if (s.startsWith('S2')||s.startsWith('C2')||s.startsWith('E1031')) return [MCG_TIER['2inch'],'MCG tier (2")'];
  if (['S3','C3','SX','CX','S1'].some(p=>s.startsWith(p))) return [MCG_TIER['4inch'],'MCG tier (4")'];
  return [null, null];
}

function getCost(sku, vendor, mcgCosts, productCosts) {
  const key = (sku || '').toUpperCase().trim();
  if (mcgCosts[key] !== undefined)    return [mcgCosts[key],    'MCG Total sheet'];
  if (productCosts[key] !== undefined) return [productCosts[key], 'Products export'];
  if (isMcgSku(sku)) {
    const [cost, label] = mcgTierCost(sku);
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

export function calculate(orderRows, shipStationCosts, mcgCosts, productCosts, skuWeights) {
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

    const lineRevenue = Math.round((unitPrice * qty - lineDiscount) * 100) / 100;
    const [unitCost, costSource] = getCost(sku, vendor, mcgCosts, productCosts);
    const lineCogs = unitCost !== null ? Math.round(unitCost * qty * 100) / 100 : null;
    const lineGp   = lineCogs !== null ? Math.round((lineRevenue - lineCogs) * 100) / 100 : null;
    const lineGpPct = (lineGp !== null && lineRevenue !== 0)
      ? Math.round(lineGp / lineRevenue * 1000) / 10 : null;

    // Shipping (order-level, first row only)
    let shipCollected = null, shipPaid = null, shipDelta = null, shipNote = null;
    let isFreeShip = '';

    if (isFirstRow) {
      shipCollected = custShipping;
      isFreeShip = custShipping === 0 ? 'YES' : '';

      if (orderCat === 'Pure HP Dropship') {
        const hpW    = orderHpWeight.get(orderNum) || 0;
        const hpRate = hpW > 0 ? hpShipRate(hpW) : custShipping;
        shipPaid  = hpRate;
        shipDelta = Math.round((custShipping - hpRate) * 100) / 100;
        shipNote  = `HP pass-through (${hpW.toFixed(2)}lb)`;

      } else if (orderCat === 'Pure 17381') {
        shipPaid  = ssRate;
        shipDelta = ssRate !== null ? Math.round((custShipping - ssRate) * 100) / 100 : null;
        shipNote  = 'ShipStation';

      } else if (orderCat === 'Pure Free Ship') {
        shipPaid  = 0;
        shipDelta = 0;
        shipNote  = 'Ships free';

      } else if (orderCat === 'Mixed (17381 + HP Dropship)') {
        const hpW    = orderHpWeight.get(orderNum) || 0;
        const hpRate = hpShipRate(hpW);
        shipPaid  = Math.round(((ssRate || 0) + hpRate) * 100) / 100;
        shipDelta = ssRate !== null
          ? Math.round((custShipping - hpRate - ssRate) * 100) / 100 : null;
        shipNote  = `17381:ShipStation + HP:${hpW.toFixed(2)}lb=$${hpRate.toFixed(2)}`;

      } else {
        shipPaid  = ssRate;
        shipDelta = ssRate !== null ? Math.round((custShipping - ssRate) * 100) / 100 : null;
        shipNote  = orderCat;
      }
    }

    lineItems.push({
      orderNum, date, source, orderCat: isFirstRow ? orderCat : null,
      store, vendor, sku, product, qty,
      unitPrice, lineRevenue, unitCost, costSource, lineCogs, lineGp, lineGpPct,
      shipCollected, isFreeShip, shipPaid, shipDelta, shipNote
    });

    orderSeen.add(orderNum);
  }

  return lineItems;
}

// ─── Aggregation helpers ──────────────────────────────────────────────────────

export function summarize(lineItems) {
  let totalRevenue = 0, totalCogs = 0, totalGp = 0;
  let missingCost = 0;
  const byStore = {};
  const byChannel = {};
  const shipByType = {};

  for (const li of lineItems) {
    totalRevenue += li.lineRevenue || 0;
    totalCogs    += li.lineCogs   || 0;
    if (li.lineGp !== null) totalGp += li.lineGp;
    if (li.costSource === 'COST MISSING') missingCost++;

    // By store
    const s = li.store || 'Unknown';
    if (!byStore[s]) byStore[s] = { revenue:0, cogs:0, gp:0, orders:new Set() };
    byStore[s].revenue += li.lineRevenue || 0;
    byStore[s].cogs    += li.lineCogs   || 0;
    if (li.lineGp !== null) byStore[s].gp += li.lineGp;
    byStore[s].orders.add(li.orderNum);

    // By channel
    if (li.source) {
      const c = li.source;
      if (!byChannel[c]) byChannel[c] = { revenue:0, gp:0 };
      byChannel[c].revenue += li.lineRevenue || 0;
      if (li.lineGp !== null) byChannel[c].gp += li.lineGp;
    }

    // Shipping by order type
    if (li.shipCollected !== null) {
      const t = li.orderCat || 'Other';
      if (!shipByType[t]) shipByType[t] = { collected:0, paid:0, delta:0, orders:0, noDelta:0 };
      shipByType[t].collected += li.shipCollected || 0;
      if (li.shipPaid !== null)  shipByType[t].paid    += li.shipPaid;
      if (li.shipDelta !== null) shipByType[t].delta   += li.shipDelta;
      else shipByType[t].noDelta++;
      shipByType[t].orders++;
    }
  }

  // Convert Set → count
  for (const s of Object.values(byStore)) s.orders = s.orders.size;

  const gpPct = totalRevenue > 0 ? (totalGp / totalRevenue * 100) : 0;

  return { totalRevenue, totalCogs, totalGp, gpPct, missingCost, byStore, byChannel, shipByType };
}
