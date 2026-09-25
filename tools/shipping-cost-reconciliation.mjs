#!/usr/bin/env node
/**
 * shipping-cost-reconciliation.mjs — LOCAL-ONLY join of a Shopify orders export
 * and a ShipStation Shipping Cost Report, by Shopify order date.
 *
 *   node tools/shipping-cost-reconciliation.mjs --orders <orders.csv> --report <shipping_cost.csv> \
 *        --from 2026-08-01 --to 2026-09-21 [--collective "Lively Root"]
 *
 * Privacy rules (Revision 9):
 *   • paths are given explicitly; directories are never scanned
 *   • files inside the repository are refused (real exports never enter Git)
 *   • output is aggregates only: counts and sums, never names, addresses,
 *     rows or order numbers; the output itself must never be committed
 *   • the raw report's Recipient / Shipping Paid / +/- are dropped on read
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCSV, calculate } from '../shared/calculator.js';
import { sanitizeShippingCostReport, parseShippingCostReport, aggregateByOrder, canonicalOrderKey, fromCents } from '../shared/adapters/shippingCostReport.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function refuseRepoPath(p) {
  const abs = path.resolve(p);
  const rel = path.relative(REPO, abs);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error('Refusing a file inside the repository: real exports must stay outside Git');
  if (!fs.statSync(abs).isFile()) throw new Error('Expected a file path, not a directory');
  return abs;
}

const read = p => fs.readFileSync(refuseRepoPath(p), 'utf8').replace(/^\uFEFF/, '');
const c2 = c => fromCents(c).toFixed(2);

/** Pure: aggregates only. */
export function reconcile({ orderRows, reportRows, from, to, collectiveVendors = ['Lively Root'] }) {
  const s = sanitizeShippingCostReport(reportRows);
  const dates = s.rows.map(r => r['Ship Date']);
  const p = parseShippingCostReport(s.rows, { requestedFrom: '1900-01-01', requestedTo: '2999-12-31' });
  const agg = aggregateByOrder(p.rows);

  const first = new Map();
  for (const r of orderRows) if (!first.has(r['Name'])) first.set(r['Name'], r);
  const byKey = new Map([...first.values()].map(r => [canonicalOrderKey(r['Name']), r]));
  const keys = [...byKey.keys()].filter(k => /^\d+$/.test(k)).sort();
  const lines = calculate(orderRows, new Map(), {}, {}, {}, {}, {}, {}, null, {}, null, null);
  const eng = new Map();
  for (const l of lines) {
    const k = canonicalOrderKey(l.orderNum);
    const e = eng.get(k) || { cat: null, stores: new Set() };
    if (l.orderCat) e.cat = l.orderCat; e.stores.add(l.store); eng.set(k, e);
  }
  const linesOf = k => orderRows.filter(r => canonicalOrderKey(r['Name']) === k);
  const dateOf = k => String(byKey.get(k)['Created at']).slice(0, 10);

  const out = { report: { rows: p.rowCount, orders: agg.size, multiRowOrders: [...agg.values()].filter(a => a.rowCount > 1).length,
    shippingCost: c2(p.shippingCostCents), shipDates: `${dates.length ? p.firstShipDate : '-'}..${dates.length ? p.lastShipDate : '-'}` } };
  const bucket = () => ({ orders: 0, rows: 0, cents: 0 });
  const b = { inPeriod: bucket(), beforePeriod: bucket(), afterPeriod: bucket(), unmatchedBelowExport: bucket(), unmatchedAboveExport: bucket(), unmatchedInsideExport: bucket() };
  for (const a of agg.values()) {
    let t;
    if (!byKey.has(a.orderKey)) t = a.orderKey < keys[0] ? 'unmatchedBelowExport' : a.orderKey > keys[keys.length - 1] ? 'unmatchedAboveExport' : 'unmatchedInsideExport';
    else { const d = dateOf(a.orderKey); t = d < from ? 'beforePeriod' : d > to ? 'afterPeriod' : 'inPeriod'; }
    b[t].orders++; b[t].rows += a.rowCount; b[t].cents += a.costCents;
  }
  out.reportRowsByOrderDate = Object.fromEntries(Object.entries(b).map(([k, v]) => [k, { orders: v.orders, rows: v.rows, shippingCost: c2(v.cents) }]));

  // Shopify orders in the period, by ShipStation expectation.
  const cls = {};
  const add = (k, name) => { cls[name] ||= { orders: 0, matched: 0, cents: 0 }; cls[name].orders++; if (agg.has(k)) { cls[name].matched++; cls[name].cents += agg.get(k).costCents; } };
  for (const k of byKey.keys()) {
    const d = dateOf(k); if (d < from || d > to) continue;
    const f = byKey.get(k), e = eng.get(k), ls = linesOf(k);
    const cancelled = String(f['Cancelled at'] || '').trim() !== '';
    if (!e) add(k, cancelled ? (String(f['Fulfillment Status']) !== 'fulfilled' && ls.every(r => ['pending', 'restocked'].includes(r['Lineitem fulfillment status'])) ? 'excluded:cancelled_before_fulfillment' : 'excluded:cancelled_other') : 'excluded:no_sku_line');
    else if ([...e.stores].some(s => collectiveVendors.includes(s)) && ['Other', 'Pure HP Dropship'].includes(e.cat)) add(k, 'excluded:vendor_fulfilled_shopify_collective');
    else if (e.cat === 'Pure HP Dropship') add(k, 'excluded:pure_hpd');
    else if (!ls.some(r => r['Lineitem requires shipping'] === 'true')) add(k, 'excluded:no_shipping_required');
    else add(k, 'expected_shipstation');
  }
  out.shopifyOrdersInPeriod = Object.fromEntries(Object.entries(cls).sort().map(([k, v]) => [k, { orders: v.orders, matched: v.matched, shippingCost: c2(v.cents) }]));
  const e = cls.expected_shipstation || { orders: 0, matched: 0 };
  out.coverage = { expected: e.orders, matched: e.matched, percent: e.orders ? (100 * e.matched / e.orders).toFixed(2) : null };
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const a = process.argv.slice(2), arg = n => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : undefined; };
  if (!arg('orders') || !arg('report') || !arg('from') || !arg('to')) { console.error('usage: --orders <csv> --report <csv> --from YYYY-MM-DD --to YYYY-MM-DD'); process.exit(2); }
  const r = reconcile({ orderRows: parseCSV(read(arg('orders'))), reportRows: parseCSV(read(arg('report'))), from: arg('from'), to: arg('to'),
    collectiveVendors: arg('collective') ? arg('collective').split(',').map(s => s.trim()) : undefined });
  console.log(JSON.stringify(r, null, 2));
}
