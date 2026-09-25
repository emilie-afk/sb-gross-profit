/**
 * catalogBuild.js — build.py's cost tables, built from fetched sheet text
 * =======================================================================
 * A line-for-line port of the table building in build.py and vendor_sheets.py
 * so the Worker can fetch the cost sheets itself (C6) and produce the same
 * catalog the dashboard uses. No network here: the caller passes the text of
 * each configured source, keyed by the build.py environment variable name.
 *
 *   buildCatalogTables({ MCG_SHEET_URL: text, ..., productExport: { name, text } })
 *     → { tables, mcgExtra, report }
 *
 * Python semantics that change results are reproduced (pyCompat.js): csv
 * module parsing, str.strip, float(), round(x, 4), dict insertion order and
 * first-wins / last-wins rules. Parity with build.py itself is checked by
 * tools/catalog-parity/ and tests/catalog-build.test.mjs.
 *
 * Never pass URLs or keys in here; this module only sees sheet contents.
 */
import { pyCsvRows, pyDictRows, pyZipDict, pyGet, pyOr, pyTruthy, pyStrip, pyStripStr, pyFloat, pyRound, PY_WS, PyCompatError } from './pyCompat.js';
import { MANUAL_MCG_COSTS, MANUAL_LR_COSTS } from './catalogManual.js';
import { parseMcgExtraCsv } from './catalog.js';

export { PyCompatError };

/** Every source build.py reads, by its environment variable name. */
export const URL_SOURCES = Object.freeze([
  'MCG_SHEET_URL', 'MCG_POTS_SHEET_URL', 'SB_SKU_ALIAS_URL', 'SB_SKU_ALIAS_URL_2', 'HP_SKU_ALIAS_URL',
  'AS_SHEET_URL', 'L2G_SHEET_URL', 'LIVELY_GOOD_SHEET_URL', 'CALATHEA_COLLECTIVE_SHEET_URL',
  'SURFSIDE_ARRANGEMENT_SHEET_URL', 'LINDAMAKES_SHEET_URL', 'HP_SHEET_URL', 'MCG_EXTRA_SHEET_URL',
]);
export const JSON_SOURCES = Object.freeze(['PRODUCT_COSTS_JSON1', 'PRODUCT_COSTS_JSON2', 'SKU_WEIGHTS_JSON']);
export const DRIVE_SOURCES = Object.freeze(['HP_COSTS_FOLDER_ID', 'GDRIVE_API_KEY']);

export const LIVE_TO_GIVE = 'Live to Give';
export const VENDOR_ORDER = Object.freeze([LIVE_TO_GIVE, 'Lively Good', 'Calathea Collective', 'Surfside Arrangement', 'LindaMakes']);
export const VENDOR_ENV = Object.freeze({
  'Live to Give': 'L2G_SHEET_URL', 'Lively Good': 'LIVELY_GOOD_SHEET_URL', 'Calathea Collective': 'CALATHEA_COLLECTIVE_SHEET_URL',
  'Surfside Arrangement': 'SURFSIDE_ARRANGEMENT_SHEET_URL', 'LindaMakes': 'LINDAMAKES_SHEET_URL',
});

const has = v => typeof v === 'string';
const WS = `[${PY_WS}]`;
const RE = {
  ws: new RegExp(`${WS}+`, 'g'),
  mcgDescSku: new RegExp(`^[A-Z0-9]{4,}${WS}+`, 'i'),
  notAlnumWs: new RegExp(`[^a-z0-9${PY_WS}]`, 'g'),
  notSkuChar: /[^A-Z0-9]/g,
};
const lower = s => s.toLowerCase();
const upper = s => s.toUpperCase();

/** build.py clean_money: float(str(s) without $ and ,) or None. */
function buildMoney(s) {
  const v = pyFloat(pyStrip((s === null || s === undefined ? 'None' : String(s)).replace(/\$/g, '').replace(/,/g, '')));
  return v;
}
/** vendor_sheets clean_money: None for None / empty, else float or None. */
function vendorMoney(s) {
  if (s === null || s === undefined) return null;
  const t = pyStrip(String(s).replace(/\$/g, '').replace(/,/g, ''));
  if (!t) return null;
  return pyFloat(t);
}
function finiteOrThrow(v, where) {
  if (v !== null && typeof v === 'number' && !Number.isFinite(v) && !Number.isNaN(v)) throw new PyCompatError('non_finite_cost', `${where}: an infinite cost cannot be stored`);
  return v;
}
const pos = v => v !== null && pyTruthy(v) && v > 0;           // `cost and cost > 0`

// ─── vendor_sheets.py ─────────────────────────────────────────────────────────
export const normalizeSku = s => upper(pyStrip(s || '').replace(RE.ws, ' '));
export const looseSku = s => normalizeSku(s).replace(RE.notSkuChar, '');
export function normalizeName(s) {
  const parts = (s || '').split('\n');
  return pyStrip(lower(parts[parts.length - 1]).replace(RE.notAlnumWs, ' ').replace(RE.ws, ' '));
}
function displayName(s) {
  const parts = (s || '').split('\n').map(p => pyStrip(p)).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}
function findHeaderRow(rows, required, maxScan = 6) {
  const want = required.map(lower);
  for (let i = 0; i < Math.min(rows.length, maxScan); i++) {
    const cells = rows[i].map(c => lower(pyStrip(c)));
    if (want.every(w => cells.some(c => w === c || c.includes(w)))) return i;
  }
  return null;
}
function colIndex(header, candidates) {
  const norm = header.map(c => lower(pyStrip(c || '')).replace(RE.ws, ' '));
  const cands = candidates.map(c => lower(pyStrip(c)).replace(RE.ws, ' '));
  for (const c of cands) for (let i = 0; i < norm.length; i++) if (norm[i] === c) return i;
  for (const c of cands) for (let i = 0; i < norm.length; i++) if (norm[i].startsWith(c)) return i;
  return null;
}
const VENDOR_SPECS = {
  'Live to Give': { headerRequired: ['sku'], sku: ['SKUs', 'SKU'], cost: ['Dropship Price (60% of retail price)', 'Dropship Price', 'Cost'], name: ['Shopify Name', 'Product'], carryName: true, active: null },
  'Lively Good': { headerRequired: ['sku', 'cost per item'], sku: ['SKU'], cost: ['Cost per item'], name: ['Title'], carryName: false, active: ['Listing Shopify'] },
  'Calathea Collective': { headerRequired: ['sku', 'cost'], sku: ['SKU'], cost: ['Cost (what Calathea Collective receives)', 'Cost'], name: ['Product'], carryName: true, active: null },
  'Surfside Arrangement': { headerRequired: ['sb sku'], sku: ['SB SKU', 'SKU'], cost: ['Cost (what Surfside Succulents receives)', 'Cost'], name: ['Product'], carryName: true, active: null },
  'LindaMakes': { headerRequired: ['sku', 'cost'], sku: ['SKU'], cost: ['Cost (what LindaMakes receives)', 'Cost'], name: ['Product'], carryName: true, active: null },
};

/** vendor_sheets.parse_vendor_tab → { catalog: Map, stats, errors } */
export function parseVendorTab(vendor, rows) {
  const spec = VENDOR_SPECS[vendor];
  const stats = { vendor, rows_fetched: Math.max(0, rows.length - 1), rows_accepted: 0, unique_skus: 0, duplicate_skus: 0, blank_skus: 0,
    invalid_costs: 0, zero_or_negative: 0, inactive_skipped: 0, conflicting_duplicates: 0, imported: 0 };
  const errors = [];
  const hdr = findHeaderRow(rows, spec.headerRequired);
  if (hdr === null) { errors.push(`${vendor}: could not locate a header row`); return { catalog: new Map(), stats, errors }; }
  const header = rows[hdr];
  const iSku = colIndex(header, spec.sku), iCost = colIndex(header, spec.cost), iName = spec.name ? colIndex(header, spec.name) : null;
  let iAct = null;
  if (spec.active) for (const r of rows.slice(0, hdr + 1)) { iAct = colIndex(r, spec.active); if (iAct !== null) break; }
  if (iSku === null || iCost === null) { errors.push(`${vendor}: SKU or cost column not found`); return { catalog: new Map(), stats, errors }; }
  const data = rows.slice(hdr + 1);
  stats.rows_fetched = data.length;
  const cell = (row, idx) => (idx !== null && idx < row.length ? pyStrip(row[idx]) : '');
  const collected = new Map();
  let currentName = '';
  for (const row of data) {
    if (!row.some(c => pyStrip(c))) continue;
    const nameCell = cell(row, iName);
    if (nameCell) currentName = nameCell;
    const rawSku = cell(row, iSku);
    if (!rawSku) { stats.blank_skus++; continue; }
    if (iAct !== null) {
      const flag = upper(pyStrip(cell(row, iAct)));
      if (!['TRUE', 'YES', 'X', '1', 'CHECKED'].includes(flag)) { stats.inactive_skipped++; continue; }
    }
    const cost = finiteOrThrow(vendorMoney(cell(row, iCost)), vendor);
    if (cost === null) { stats.invalid_costs++; continue; }
    if (cost <= 0) { stats.zero_or_negative++; continue; }
    if (Number.isNaN(cost)) throw new PyCompatError('non_finite_cost', `${vendor}: a NaN cost cannot be stored`);
    const pname = !spec.carryName ? nameCell : (nameCell || currentName);
    const key = normalizeSku(rawSku);
    if (!collected.has(key)) collected.set(key, []);
    collected.get(key).push([pyRound(cost, 4), rawSku, displayName(pname)]);
    stats.rows_accepted++;
  }
  const catalog = new Map();
  for (const [key, entries] of collected) {
    const costs = new Set(entries.map(e => e[0]));
    if (entries.length > 1) stats.duplicate_skus++;
    if (costs.size > 1) { stats.conflicting_duplicates++; errors.push(`${vendor}: a SKU has conflicting costs — not imported`); continue; }
    const [cost, rawSku, pname] = entries[0];
    catalog.set(key, { unitCost: cost, sku: rawSku, productName: pname, source: `${vendor} sheet`, matchType: 'exact_sku' });
  }
  stats.unique_skus = collected.size;
  stats.imported = catalog.size;
  return { catalog, stats, errors };
}

// ─── build.py ────────────────────────────────────────────────────────────────
const HP_VENDORS = new Set(['House Plant Dropship', 'House Plant Shop', 'House Plant Wholesale']);
const normalizeTitle = s => pyStrip(lower(s).replace(RE.notAlnumWs, '').replace(RE.ws, ' '));

function parseShopifyExportRows(rows) {
  const sb = new Map(), hp = new Map(), hpByName = new Map();
  let vendor = '', title = '';
  for (const row of rows) {
    const v = pyStrip(pyOr(pyGet(row, 'Vendor'), '') ?? ''); if (v) vendor = v;
    const t = pyStrip(pyOr(pyGet(row, 'Title'), '') ?? ''); if (t) title = t;
    const sku = upper(pyStrip(pyOr(pyGet(row, 'Variant SKU'), '') ?? ''));
    const cost = finiteOrThrow(buildMoney(pyGet(row, 'Cost per item', '')), 'product export');
    if (pos(cost)) {
      if (sku) { if (vendor === 'Succulents Box') sb.set(sku, cost); else if (HP_VENDORS.has(vendor)) hp.set(sku, cost); }
      if (HP_VENDORS.has(vendor) && title) { const k = normalizeTitle(title); if (k && !hpByName.has(k)) hpByName.set(k, cost); }
    }
  }
  return { sb, hp, hpByName };
}

const ALIAS_SIGNALS = new Set(['sku', 'succulent sku', 'sb sku', 'mcg sku', 'amazon sku', 'amazon alias', 'seller sku', 'alias', 'internal sku', 'variant sku']);
function parseAliasRows(rawRows) {
  const idx = rawRows.findIndex(r => r.map(c => lower(pyStrip(c))).filter(c => ALIAS_SIGNALS.has(c)).length >= 2);
  if (idx < 0) return null;
  const header = rawRows[idx];
  return rawRows.slice(idx + 1).map(r => pyZipDict(header, r));
}

const toObj = m => Object.fromEntries(m);

/**
 * @param {object} src  { <ENV NAME>: text } for configured URL sources,
 *                      { PRODUCT_COSTS_JSON1|2, SKU_WEIGHTS_JSON: json text },
 *                      productExport: { name, text } | undefined (Drive's latest export)
 */
export function buildCatalogTables(src) {
  const warnings = [];
  const report = { sources: {}, vendorStats: [], warnings };

  // 1. MCG
  const mcg = new Map();
  if (has(src.MCG_SHEET_URL)) {
    const rows = pyDictRows(src.MCG_SHEET_URL);
    for (const row of rows) {
      const sku = upper(pyStripStr(pyGet(row, 'SKU', '')));
      const cost = finiteOrThrow(buildMoney(pyOr(pyGet(row, 'Cost Per Item', ''), pyGet(row, 'Cost_Per_Item', ''))), 'MCG');
      if (sku && pos(cost)) {
        mcg.set(sku, cost);
        const desc = pyStripStr(pyGet(row, 'Description', ''));
        let name = desc.replace(RE.mcgDescSku, '').split('/')[0];
        name = pyStrip(lower(name).replace(RE.notAlnumWs, ' ').replace(RE.ws, ' '));
        if (name && !mcg.has('__n__' + name)) mcg.set('__n__' + name, cost);
      }
    }
    report.sources.MCG_SHEET_URL = { rows: rows.length };
  }
  if (has(src.MCG_POTS_SHEET_URL)) {
    const raw = pyCsvRows(src.MCG_POTS_SHEET_URL);
    const SIGNALS = ['pot sku', 'sku', 'variant sku'];
    const hi = raw.findIndex(r => { const low = r.map(c => lower(pyStrip(c))); return SIGNALS.some(s => low.includes(s)); });
    let potCount = 0;
    if (hi >= 0) {
      for (const r of raw.slice(hi + 1)) {
        const row = pyZipDict(raw[hi], r);
        const sku = upper(pyStrip(pyOr(pyGet(row, 'Pot SKU'), pyGet(row, 'SKU'), pyGet(row, 'Variant SKU'), pyGet(row, 'pot sku'), '')));
        const cost = finiteOrThrow(buildMoney(pyOr(pyGet(row, 'Pot Cost'), pyGet(row, 'Cost'), pyGet(row, 'Cost per item'), pyGet(row, 'Cost Per Item'),
          pyGet(row, 'Cost_Per_Item'), pyGet(row, 'pot cost'), '')), 'MCG pots');
        if (sku && pos(cost)) {
          mcg.set(sku, cost);
          const base = sku.split('.')[0];
          if (base && base !== sku && !mcg.has(base)) mcg.set(base, cost);
          potCount++;
        }
      }
    } else warnings.push('MCG pots: header row not found');
    report.sources.MCG_POTS_SHEET_URL = { rows: raw.length, potSkus: potCount };
  }

  // 1c. SKU alias
  const alias = new Map();
  for (const key of ['SB_SKU_ALIAS_URL', 'SB_SKU_ALIAS_URL_2', 'HP_SKU_ALIAS_URL']) {
    if (!has(src[key])) continue;
    const rows = parseAliasRows(pyCsvRows(src[key]));
    let count = 0;
    if (rows === null) warnings.push(`${key}: header row not found`);
    else for (const row of rows) {
      const rlow = new Map();
      for (const [k, v] of row) if (pyStrip(v)) rlow.set(lower(pyStrip(k)), upper(pyStrip(v)));
      const g = k => pyGet(rlow, k);
      const sb = pyOr(g('succulent sku'), g('sb sku'), g('mcg sku'), g('internal sku'), g('sku'), g('variant sku'), '');
      const amz = pyOr(g('amazon sku'), g('amazon alias'), g('amazon'), g('seller sku'), g('alias'), g('msku'), '');
      if (sb && amz && sb !== amz) { alias.set(amz, sb); alias.set(sb, sb); count++; }
    }
    report.sources[key] = { mappings: count };
  }

  // 2. Air Plant Shop
  const as = new Map();
  if (has(src.AS_SHEET_URL)) {
    for (const row of pyDictRows(src.AS_SHEET_URL)) {
      const sku = upper(pyStripStr(pyOr(pyGet(row, 'SKU ', ''), pyGet(row, 'SKU', ''))));
      const cost = finiteOrThrow(buildMoney(pyGet(row, 'Fullfilled Price', '')), 'Air Plant Shop');
      if (sku && pos(cost)) as.set(sku, cost);
    }
    report.sources.AS_SHEET_URL = { skus: as.size };
  }

  // 3. Vendor catalogs
  const vendorCatalog = new Map(VENDOR_ORDER.map(v => [v, new Map()]));
  for (const vendor of VENDOR_ORDER) {
    const env = VENDOR_ENV[vendor];
    if (!has(src[env])) { warnings.push(`${env} not set — no ${vendor} costs imported`); report.vendorStats.push({ vendor, configured: false, imported: 0 }); continue; }
    const { catalog, stats, errors } = parseVendorTab(vendor, pyCsvRows(src[env]));
    vendorCatalog.set(vendor, catalog);
    report.vendorStats.push({ ...stats, configured: true });
    warnings.push(...errors);
    if (stats.imported === 0) warnings.push(`${vendor}: configured but produced ZERO valid costs`);
  }
  const vendorIndex = new Map();
  for (const [vendor, entries] of vendorCatalog) {
    const byLoose = new Map(), byName = new Map();
    for (const [key, e] of entries) {
      const lk = looseSku(key); if (lk && !byLoose.has(lk)) byLoose.set(lk, key);
      const nk = normalizeName(e.productName || ''); if (nk && !byName.has(nk)) byName.set(nk, key);
    }
    vendorIndex.set(vendor, { byLooseSku: toObj(byLoose), byName: toObj(byName) });
  }
  const l2g = new Map([...vendorCatalog.get(LIVE_TO_GIVE)].map(([k, v]) => [k, v.unitCost]));

  // 4. HP Dropship sheet (later rows win), then the env-var fallback
  let hp = new Map(), weights = new Map();
  if (has(src.HP_SHEET_URL)) {
    for (const row of pyDictRows(src.HP_SHEET_URL)) {
      const sku = upper(pyStripStr(pyGet(row, 'SKU', '')));
      const cost = finiteOrThrow(buildMoney(pyGet(row, 'Cost', '')), 'HP sheet');
      const w = finiteOrThrow(buildMoney(pyGet(row, 'WeightLb', '')), 'HP sheet');
      if (sku && pos(cost)) hp.set(sku, cost);
      if (sku && pos(w)) weights.set(sku, w);
    }
    report.sources.HP_SHEET_URL = { costSkus: hp.size, weightSkus: weights.size };
  }
  if (!hp.size) {
    const j = k => (has(src[k]) ? JSON.parse(src[k]) : {});
    hp = new Map([...Object.entries(j('PRODUCT_COSTS_JSON1')), ...Object.entries(j('PRODUCT_COSTS_JSON2'))]);
    weights = new Map(Object.entries(j('SKU_WEIGHTS_JSON')));
    report.sources.hpFallback = { costSkus: hp.size, weightSkus: weights.size };
  }

  // 5. Shopify product export (Drive's latest). Without one build.py writes no
  //    sb_costs / hp_supplement / hp_by_name files, so the push omits them.
  let exportTables = null;
  if (src.productExport && has(src.productExport.text)) {
    const rows = pyDictRows(src.productExport.text);
    if (rows.length) {
      const e = parseShopifyExportRows(rows);
      exportTables = { sb_costs: toObj(e.sb), hp_supplement: toObj(e.hp), hp_by_name: toObj(e.hpByName) };
      report.sources.productExport = { name: src.productExport.name || null, sb: e.sb.size, hp: e.hp.size, hpTitles: e.hpByName.size };
    }
  }

  // 6. Merge, manual MCG (fills gaps), manual Lively Root (overrides)
  const product = new Map(hp);
  for (const [k, v] of as) product.set(k, v);
  for (const [k, v] of l2g) product.set(k, v);
  for (const [sku, cost] of MANUAL_MCG_COSTS) { if (!mcg.has(sku)) mcg.set(sku, cost); if (!mcg.has(upper(sku))) mcg.set(upper(sku), cost); }
  for (const [sku, cost] of MANUAL_LR_COSTS) { mcg.set(sku, cost); mcg.set(upper(sku), cost); }

  const tables = {
    mcg_total: toObj(mcg), product_costs: toObj(product), sku_weights: toObj(weights), sku_alias: toObj(alias),
    vendor_costs: Object.fromEntries([...vendorCatalog].map(([v, m]) => [v, toObj(m)])), vendor_index: toObj(vendorIndex),
    ...(exportTables || {}),
  };
  const mcgExtra = has(src.MCG_EXTRA_SHEET_URL) ? parseMcgExtraCsv(src.MCG_EXTRA_SHEET_URL) : {};
  return { tables, mcgExtra, report };
}
