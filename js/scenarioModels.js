/**
 * scenarioModels.js — the parts of the Scenarios models that decide money, kept pure and tested
 * ============================================================================================
 * Used by index.html for CSV and automatic (saved) reports alike.
 *
 *   mcgVolumeOrders(lines, mcgPack)   per Succulents Box order: the plants eligible for an MCG volume
 *                                     discount, by the engine's own rule (mcgPlantUnits). Packs and
 *                                     random/Mystery plants (MCG pack sheet SKUs) are never eligible;
 *                                     an order with no eligible plant is not in any tier.
 *   projectionUnitCost(...)           a SKU's unit cost for the price projection: the average of its
 *                                     known-cost sales, else the engine's shared cost resolver over all
 *                                     cost tables (MCG pack sheet included). Unknown stays null, never $0.
 *   projectionTotals(rows, baseline)  revenue, known cost and GP with unknown costs left unknown: GP is
 *                                     known-cost GP and is marked incomplete when any cost is unknown.
 */
import { resolveCost, mcgPlantUnits } from '../shared/calculator.js';

const r2 = x => Math.round((Number(x) || 0) * 100) / 100;
const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

/** The pack table is usable when it is a non-empty object (missing table → the model cannot exclude packs). */
export const hasPackTable = mcgPack => !!mcgPack && typeof mcgPack === 'object' && Object.keys(mcgPack).length > 0;

/**
 * @returns {{ orders: Map<string,{plants:number, excludedUnits:number, revenue:number, netGp:number, netGpIncomplete:boolean}>,
 *             excluded: { units:number, orders:number } }}
 */
export function mcgVolumeOrders(lines, mcgPack) {
  const orders = new Map();
  let exUnits = 0; const exOrders = new Set();
  for (const li of lines) {
    if (!(li.store || '').includes('Succulents Box')) continue;
    const qty = li.qty || 0;
    const plants = mcgPlantUnits(li.sku || '', qty, mcgPack);
    const sku = (li.sku || '').toUpperCase();
    const isPack = hasPackTable(mcgPack) && sku.split('+').some(p => has(mcgPack, p.trim()));
    if (isPack) { exUnits += qty; exOrders.add(li.orderNum); }
    const o = orders.get(li.orderNum) || orders.set(li.orderNum, { plants: 0, excludedUnits: 0, revenue: 0, netGp: 0, netGpIncomplete: false }).get(li.orderNum);
    o.plants += plants;
    if (isPack) o.excludedUnits += qty;
    o.revenue = r2(o.revenue + (li.lineRevenue || 0));
    if (li.lineNetGp === null || li.lineNetGp === undefined) o.netGpIncomplete = true; else o.netGp = r2(o.netGp + li.lineNetGp);
  }
  for (const [k, o] of orders) if (o.plants <= 0) orders.delete(k);        // nothing eligible: not in any tier
  return { orders, excluded: { units: exUnits, orders: exOrders.size } };
}

export const MCG_TIERS = ['1', '2–3', '4–7', '8+'];
export const mcgTierOf = plants => (plants <= 1 ? '1' : plants <= 3 ? '2–3' : plants <= 7 ? '4–7' : '8+');

/** Savings of a per-plant discount by tier, on eligible plants only. */
export function mcgVolumeSavings(volume, discs) {
  const tiers = Object.fromEntries(MCG_TIERS.map(t => [t, { orders: 0, plants: 0 }]));
  for (const o of volume.orders.values()) { const t = tiers[mcgTierOf(o.plants)]; t.orders++; t.plants += o.plants; }
  let total = 0;
  for (const [t, v] of Object.entries(tiers)) { v.savings = r2((discs[t] || 0) * v.plants); total = r2(total + v.savings); }
  return { tiers, total };
}

/**
 * @param {object[]} lines   the SKU's sold lines (may be empty for a new SKU)
 * @param {object}   t       cost tables { mcgCosts, productCosts, additionalCosts, hpByName, skuAlias, mcgExtra, vendorCosts, vendorIndex, mcgPack }
 * @returns {{ cost: number|null, source: string }}
 */
export function projectionUnitCost(lines, sku, product, vendor, t = {}) {
  const known = (lines || []).filter(l => l.lineCogs !== null && l.lineCogs !== undefined && (l.qty || 0) > 0);
  if (known.length) {
    const q = known.reduce((s, l) => s + l.qty, 0);
    return { cost: r2(known.reduce((s, l) => s + l.lineCogs, 0) / q), source: 'Average known cost of sales in this report' };
  }
  if (!(sku || '').trim()) return { cost: null, source: 'No SKU' };
  const [c, label] = resolveCost(sku, vendor || '', t.mcgCosts || {}, t.productCosts || {}, t.additionalCosts || {}, t.hpByName || {}, product || '',
    t.skuAlias || {}, t.mcgExtra || {}, t.vendorCosts || null, t.vendorIndex || null, t.mcgPack || null);
  return typeof c === 'number' && Number.isFinite(c) ? { cost: c, source: label } : { cost: null, source: label || 'COST MISSING' };
}

/**
 * Price projection totals. A row with an unknown cost has revenue but no cost and no GP; GP and GP % are
 * on the rows with a known cost, and `incomplete` says so. Baseline: the report's lines, same rule.
 */
export function projectionTotals(rows, baselineLines = []) {
  const per = rows.map(r => {
    const rev = r2((r.qty || 0) * (r.sellPrice || 0));
    const known = r.costPerUnit !== null && r.costPerUnit !== undefined && r.costPerUnit !== '' && Number.isFinite(Number(r.costPerUnit));
    const cogs = known ? r2((r.qty || 0) * Number(r.costPerUnit)) : null;
    const gp = known ? r2(rev - cogs) : null;
    return { id: r.id, rev, cogs, gp, gpPct: known && rev > 0 ? Math.round(gp / rev * 1000) / 10 : null };
  });
  const sum = (arr, f) => r2(arr.reduce((s, x) => s + (x[f] || 0), 0));
  const knownRows = per.filter(p => p.cogs !== null);
  const proj = { rev: sum(per, 'rev'), knownRev: sum(knownRows, 'rev'), cogs: sum(knownRows, 'cogs'), unknownRows: per.length - knownRows.length,
    revWithoutCost: r2(sum(per, 'rev') - sum(knownRows, 'rev')) };
  proj.gp = r2(proj.knownRev - proj.cogs); proj.gpPct = proj.knownRev > 0 ? Math.round(proj.gp / proj.knownRev * 1000) / 10 : null;
  proj.incomplete = proj.unknownRows > 0;
  const bKnown = baselineLines.filter(l => l.lineCogs !== null && l.lineCogs !== undefined);
  const base = { rev: r2(baselineLines.reduce((s, l) => s + (l.lineRevenue || 0), 0)), knownRev: r2(bKnown.reduce((s, l) => s + (l.lineRevenue || 0), 0)),
    cogs: r2(bKnown.reduce((s, l) => s + l.lineCogs, 0)), unknownLines: baselineLines.length - bKnown.length };
  base.revWithoutCost = r2(base.rev - base.knownRev); base.gp = r2(base.knownRev - base.cogs);
  base.gpPct = base.knownRev > 0 ? Math.round(base.gp / base.knownRev * 1000) / 10 : null; base.incomplete = base.unknownLines > 0;
  const com = { rev: r2(base.rev + proj.rev), knownRev: r2(base.knownRev + proj.knownRev), cogs: r2(base.cogs + proj.cogs), incomplete: base.incomplete || proj.incomplete };
  com.gp = r2(com.knownRev - com.cogs); com.gpPct = com.knownRev > 0 ? Math.round(com.gp / com.knownRev * 1000) / 10 : null;
  com.revWithoutCost = r2(com.rev - com.knownRev);
  return { rows: per, proj, base, com };
}
