#!/usr/bin/env node
/**
 * Historical backfill and validation, run locally against manual exports.
 *
 *   validate  Compare the automated path with the existing manual calculator,
 *             week by week, on the same source files and cost tables.
 *             Nothing is sent anywhere.
 *
 *     node tools/backfill.mjs validate --shopify orders.csv [more.csv] --shipstation ss.csv \
 *          [--hpd hpd.csv] [--data data] [--weeks 2026-08-03,2026-08-10]
 *
 *   push      Normalize locally (customer columns never leave this machine) and
 *             post to the Worker's ingest routes, one week at a time.
 *
 *     SB_INGEST_SECRET=… node tools/backfill.mjs push --worker https://… \
 *          --shopify orders.csv --shipstation ss.csv [--hpd hpd.csv] [--from 2026-01-01] [--dry-run]
 *
 * The ingest secret is read from the environment only, never from arguments.
 * Source CSVs contain customer data: keep them out of the repository.
 */
import fs from 'node:fs';
import path from 'node:path';
import { calculate, summarize, parseCSV, parseShipStation, parseHpdLog } from '../shared/calculator.js';
import { csvRowsToNormalizedOrders } from '../shared/adapters/legacy.js';
import { sanitizeShopifyOrderRows } from '../shared/adapters/shopifyCsv.js';
import { reduceShopifyOrderRows } from '../shared/adapters/shopifyPrivacy.js';
import { normalizeShipStationRows, SHIPSTATION_FIELDS, classifyCreatedBy } from '../shared/adapters/shipstation.js';
import { normalizeHpdRows } from '../shared/adapters/hpd.js';
import { buildSnapshot } from '../shared/snapshot.js';
import { weekStartOf } from '../shared/normalized.js';
import { engineArgsFromCatalog } from '../shared/catalog.js';

function args(argv) {
  const out = { _: [] }; let key = null;
  for (const a of argv) {
    if (a.startsWith('--')) { key = a.slice(2); out[key] = out[key] ?? []; if (key === 'dry-run') out[key] = true; }
    else if (key && Array.isArray(out[key])) out[key].push(a);
    else out._.push(a);
  }
  return out;
}

const readRows = files => (files || []).flatMap(f => parseCSV(fs.readFileSync(f, 'utf8')));

function loadTables(dir) {
  const read = n => { try { return JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { return {}; } };
  return { tables: { mcg_total: read('mcg_total.json'), product_costs: read('product_costs.json'), sku_weights: read('sku_weights.json'),
    sb_costs: read('sb_costs.json'), hp_supplement: read('hp_supplement.json'), hp_by_name: read('hp_by_name.json'),
    sku_alias: read('sku_alias.json'), vendor_costs: read('vendor_costs.json'), vendor_index: read('vendor_index.json') },
    mcgExtra: read('mcg_extra.json') };
}

const weekOfRow = r => weekStartOf(String(r['Created at'] ?? '').slice(0, 10));
const r2 = x => Math.round(x * 100) / 100;

function groupRowsByWeek(rows) {
  const firstWeek = new Map(), out = new Map();
  for (const r of rows) {
    const n = r['Name']; if (!n) continue;
    if (!firstWeek.has(n)) firstWeek.set(n, weekOfRow(r));
    const w = firstWeek.get(n);
    if (!out.has(w)) out.set(w, []);
    out.get(w).push(r);
  }
  return out;
}

async function validate(a) {
  const rows = readRows(a.shopify), ssRows = readRows(a.shipstation);
  const hpdText = a.hpd?.[0] ? fs.readFileSync(a.hpd[0], 'utf8') : null;
  const catalog = { rev: 'local', ...loadTables(a.data?.[0] || 'data') };
  const A = engineArgsFromCatalog(catalog);
  const legacySS = parseShipStation(ssRows);
  const shipments = normalizeShipStationRows(ssRows, { sourceFormat: ssRows[0] && 'Carrier Fee' in ssRows[0] ? 'custom' : 'legacy' }).shipments;
  const hpdMap = hpdText ? parseHpdLog(hpdText) : null;
  const hpdOrders = hpdText ? normalizeHpdRows(parseCSV(hpdText)) : [];
  const weeks = [...groupRowsByWeek(rows).entries()].filter(([w]) => !a.weeks?.length || a.weeks.join(',').split(',').includes(w)).sort();
  let failures = 0;
  console.log('week        | manual rev    auto rev   | manual COGS  auto COGS | manual ship  auto ship | manual GP    auto GP (compat) | operating GP  status');
  for (const [w, wr] of weeks) {
    const manual = summarize(calculate(wr, legacySS.costs, A.mcgCosts, A.productCosts, A.skuWeights, A.additionalCosts,
      A.hpByName, A.skuAlias, hpdMap, A.mcgExtra, A.vendorCosts, A.vendorIndex));
    const snap = buildSnapshot({ weekStart: w, orders: csvRowsToNormalizedOrders(wr), shipments, hpdOrders, catalog });
    const t = snap.totals;
    // COGS as the automated path computed it: every line, including the legacy forced Route cost,
    // so it is comparable with the manual calculator's totalCogs.
    const autoCogs = r2(snap.lines.reduce((s, l) => s + (l.lineCogs || 0), 0));
    const compatGp = r2(t.shopifyNetRevenueInclPassThrough - autoCogs - t.shippingExpense);
    const ok = Math.abs(manual.totalRevenue - t.shopifyNetRevenueInclPassThrough) < 0.005
            && Math.abs(manual.totalCogs - autoCogs) < 0.005
            && Math.abs(manual.totalShipPaid - t.shippingExpense) < 0.005
            && Math.abs(manual.totalGp - compatGp) < 0.005
            && snap.reconciliation.every(c => c.passed || !c.blocking);
    if (!ok) failures++;
    const f = n => String(r2(n).toFixed(2)).padStart(10);
    console.log(`${w}  | ${f(manual.totalRevenue)} ${f(t.shopifyNetRevenueInclPassThrough)} | ${f(manual.totalCogs)} ${f(autoCogs)} | ` +
      `${f(manual.totalShipPaid)} ${f(t.shippingExpense)} | ${f(manual.totalGp)} ${f(compatGp)}       | ${f(t.operatingGpAfterShipping)}  ${ok ? 'MATCH' : 'MISMATCH'} ${t.profitabilityStatus}`);
  }
  console.log(failures ? `\n${failures} week(s) did not reconcile. Do not publish these weeks.` : `\nAll ${weeks.length} week(s) reconcile with the manual calculator.`);
  process.exitCode = failures ? 1 : 0;
}

/**
 * Keep only allowlisted ShipStation columns, so customer columns never leave
 * this machine. `Created By` (may be a staff email) leaves only as its class.
 */
const hk = h => h.toLowerCase().replace(/[^a-z0-9#]/g, '');
const ALLOWED_SS = new Set(Object.values(SHIPSTATION_FIELDS).flat().map(hk));
const CREATED_BY = new Set(SHIPSTATION_FIELDS.createdBy.map(hk));
function stripShipStationRow(r) {
  return Object.fromEntries(Object.entries(r).filter(([k]) => ALLOWED_SS.has(hk(k)))
    .map(([k, v]) => [k, CREATED_BY.has(hk(k)) ? (classifyCreatedBy(v) === 'blank' ? '' : classifyCreatedBy(v)) : v]));
}

async function post(url, secret, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ingest-Secret': secret }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${url} → ${res.status} ${j.error || ''} ${j.message || ''}`);
  return j;
}

async function push(a) {
  const base = a.worker?.[0];
  if (!base || !/^https:\/\//.test(base)) throw new Error('--worker https://… is required');
  const secret = process.env.SB_INGEST_SECRET;
  const dry = a['dry-run'] === true;
  if (!secret && !dry) throw new Error('Set SB_INGEST_SECRET in the environment (never on the command line)');
  const from = a.from?.[0] || '0000-01-01';

  // Same privacy contract as the collector: allowlisted columns, minimum free text.
  const reduced = reduceShopifyOrderRows(sanitizeShopifyOrderRows(readRows(a.shopify)).rows);
  if (reduced.problems.length) {
    const kinds = [...new Set(reduced.problems.map(p => `${p.column}: ${p.rule}`))];
    throw new Error(`Shopify export needs review before upload (${kinds.join('; ')})`);
  }
  const byWeek = groupRowsByWeek(reduced.rows);
  for (const [w, wr] of [...byWeek.entries()].filter(([w]) => w >= from).sort()) {
    const orders = csvRowsToNormalizedOrders(wr);
    for (let i = 0; i < orders.length; i += 250) {
      const batch = orders.slice(i, i + 250);
      if (dry) { console.log(`[dry-run] shopify ${w}: ${batch.length} orders`); continue; }
      // Shopify CSV timestamps are already in the store zone (Pacific Time (US)).
      const r = await post(`${base}/v1/ingest/shopify`, secret, { format: 'normalized', storeTimezone: 'America/Los_Angeles', orders: batch, weekStart: w });
      console.log(`shopify ${w}: written ${r.rowsWritten}, duplicates ${r.duplicates}`);
    }
  }

  if (a.shipstation?.length) {
    const rows = readRows(a.shipstation).map(stripShipStationRow);
    const idKey = Object.keys(rows[0] || {}).find(k => /^shipment/i.test(k));
    const byShipment = new Map();
    for (const r of rows) { const id = r[idKey]; if (!byShipment.has(id)) byShipment.set(id, []); byShipment.get(id).push(r); }
    const groups = [...byShipment.values()];                 // never split one shipment across requests
    for (let i = 0, batch = []; i <= groups.length; i++) {
      if (i < groups.length) batch.push(...groups[i]);
      if ((batch.length >= 3000 || i === groups.length) && batch.length) {
        if (dry) console.log(`[dry-run] shipstation: ${batch.length} rows`);
        else { const r = await post(`${base}/v1/ingest/shipstation`, secret, { format: 'rows', rows: batch, sourceFormat: 'Carrier Fee' in batch[0] ? 'custom' : 'legacy' });
               console.log(`shipstation: written ${r.rowsWritten}, duplicates ${r.duplicates}, without positive cost ${r.diagnostics.shipmentsWithoutPositiveCost}`); }
        batch = [];
      }
    }
  }

  if (a.hpd?.length) {
    const hpdOrders = normalizeHpdRows(parseCSV(fs.readFileSync(a.hpd[0], 'utf8')));   // buyer notes dropped here, locally
    if (dry) console.log(`[dry-run] hpd: ${hpdOrders.length} orders`);
    else { const r = await post(`${base}/v1/ingest/hpd`, secret, { format: 'normalized', hpdOrders }); console.log(`hpd: written ${r.rowsWritten}`); }
  }
}

const a = args(process.argv.slice(2));
const cmd = a._[0];
if (cmd === 'validate') await validate(a);
else if (cmd === 'push') await push(a);
else { console.log('Usage: node tools/backfill.mjs validate|push …  (see the header of this file)'); process.exitCode = 2; }
