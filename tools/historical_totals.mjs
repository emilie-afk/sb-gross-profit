#!/usr/bin/env node
/**
 * historical_totals.mjs — before/after regression harness
 * =======================================================
 * Prints the historical gross-profit totals for a Shopify order export plus a
 * ShipStation export, using exactly the same code path as the dashboard.
 *
 *   node tools/historical_totals.mjs july_orders.csv july_shipstation.csv [--json]
 *
 * Run it on the commit before these changes and on the commit after, then diff
 * the two outputs. Expected differences are limited to:
 *   • a previously missing vendor cost becoming matched
 *   • a confirmed refund or cancellation correction
 *   • a previously duplicated ShipStation shipment cost being corrected
 *   • House Plant Dropship shipping moving off the weight-tier estimate onto
 *     the pass-through / HPD-log actual
 * Anything else needs investigating before the change is accepted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCSV, parseShipStation, calculate, summarize } from '../js/calculator.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', 'data');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const [ordersPath, shipPath] = args.filter(a => !a.startsWith('--'));
if (!ordersPath) {
  console.error('usage: node tools/historical_totals.mjs <shopify.csv> [shipstation.csv] [--json]');
  process.exit(1);
}

const readJson = (name, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); }
  catch { return fallback; }
};

const mcgCosts     = readJson('mcg_total.json', {});
const productCosts = readJson('product_costs.json', {});
const skuWeights   = readJson('sku_weights.json', {});
const sbCosts      = readJson('sb_costs.json', {});
const hpSupp       = readJson('hp_supplement.json', {});
const hpByName     = readJson('hp_by_name.json', {});
const skuAlias     = readJson('sku_alias.json', {});
const vendorCosts  = readJson('vendor_costs.json', null);
const vendorIndex  = readJson('vendor_index.json', null);

const orderRows = parseCSV(fs.readFileSync(ordersPath, 'utf8'));
const ship = shipPath
  ? parseShipStation(parseCSV(fs.readFileSync(shipPath, 'utf8')))
  : { costs: new Map(), shipments: new Map(), costColumnUsed: 'none', totalShipments: 0, zeroCostShipments: 0 };

const lines = calculate(
  orderRows, ship.costs, mcgCosts, productCosts, skuWeights,
  { ...hpSupp, ...sbCosts }, hpByName, skuAlias, null, {}, vendorCosts, vendorIndex);
const s = summarize(lines);

const bySource = {};
for (const li of lines) bySource[li.costSource] = (bySource[li.costSource] || 0) + 1;

const shipmentCount = [...(ship.shipments || new Map()).values()].reduce((n, a) => n + a.length, 0);

const out = {
  orderRowsParsed: orderRows.length,
  lineItems: lines.length,
  orders: new Set(lines.map(l => l.orderNum)).size,
  shipStationOrders: ship.costs.size,
  shipStationShipments: shipmentCount,
  shipStationCostColumn: ship.costColumnUsed || 'Rate',
  shipmentsWithNoRate: ship.zeroCostShipments ?? null,
  totalRevenueExclTax: s.totalRevenue,
  productRevenue: s.productRevenue,
  totalCogs: Math.round(s.totalCogs * 100) / 100,
  shippingCollected: Math.round(s.totalShipCollected * 100) / 100,
  shippingExpense: Math.round(s.totalShipPaid * 100) / 100,
  grossProfit: s.totalGp,
  grossProfitPct: s.gpPct,
  missingCostLines: s.missingCost,
  cancelledOrdersExcluded: orderRows.filter(r => (r['Cancelled at'] || '').trim()).length,
  refundedOrders: new Set(lines.filter(l => l.orderRefund).map(l => l.orderNum)).size,
  costSourceCounts: bySource,
};

if (asJson) { console.log(JSON.stringify(out, null, 2)); }
else {
  const money = n => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2 });
  console.log('── Historical totals ──────────────────────────────');
  console.log(`  orders                 ${out.orders}`);
  console.log(`  line items             ${out.lineItems}`);
  console.log(`  ShipStation orders     ${out.shipStationOrders} (${out.shipStationShipments} unique shipments)`);
  console.log(`  SS cost column         ${out.shipStationCostColumn} · ${out.shipmentsWithNoRate} shipment(s) with no rate`);
  console.log(`  revenue excl. taxes    ${money(out.totalRevenueExclTax)}`);
  console.log(`  product revenue        ${money(out.productRevenue)}`);
  console.log(`  product COGS           ${money(out.totalCogs)}`);
  console.log(`  shipping collected     ${money(out.shippingCollected)}`);
  console.log(`  shipping expense       ${money(out.shippingExpense)}`);
  console.log(`  GROSS PROFIT           ${money(out.grossProfit)}  (${out.grossProfitPct}%)`);
  console.log(`  lines missing cost     ${out.missingCostLines}`);
  console.log(`  cancelled orders       ${out.cancelledOrdersExcluded} (excluded)`);
  console.log(`  refunded orders        ${out.refundedOrders}`);
  console.log('\n── Cost sources ───────────────────────────────────');
  for (const [k, v] of Object.entries(out.costSourceCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(6)}  ${k}`);
  }
}
