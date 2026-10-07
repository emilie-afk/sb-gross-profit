/**
 * apsModel.js — the Air Plant Shop multi-item model's money, pure and tested
 * ==========================================================================
 * CSV uploads and saved weekly/monthly reports use the same rules.
 *
 * APS shipping cost per order (never guessed, never $0 when unknown):
 *   saved reports  APS input (shared/apsMapping.js, from the line-item export, stored separately):
 *                    aps_only       the order's ShipStation expense in the published report
 *                    split_matched  the matched APS labels' Shipping Cost Report cost, only when the Worker verified its
 *                                   rows against the rows the published snapshot pinned (snapshotCheck: verified)
 *                    anything else  no cost; the order is excluded with its reason
 *   CSV uploads    the uploaded ShipStation line-item export, same classification, cost = the APS-only
 *                  shipments' Rate (that file is the CSV report's shipping source); mixed shipments excluded.
 *
 * Model availability: the line-item export must cover the report's order dates (otherwise the exact
 * missing-data reason is given). Orders whose cost cannot be determined are excluded and listed by reason.
 */
import { APS_COST_STATUSES, APS_STATUS_TEXT, isApsSku } from '../shared/apsMapping.js';

const r2 = x => Math.round((Number(x) || 0) * 100) / 100;
const known = v => v !== null && v !== undefined && Number.isFinite(Number(v));
const key = n => String(n || '').trim().replace(/^#/, '');
const CSV_COST_STATUSES = new Set(['aps_only', 'split_matched', 'split_cost_unavailable']);

/**
 * Merge per-week APS inputs (newest export wins per order; versions are kept by the Worker).
 * @param {Array<{ versions: object[], orders: object[] }>} parts
 */
export function mergeApsInputs(parts) {
  const orders = new Map(), versions = new Map();
  for (const p of parts || []) {
    for (const v of p?.versions || []) versions.set(v.versionId, v);
    for (const o of p?.orders || []) {
      const prev = orders.get(o.orderKey);
      // The same current row comes from every week whose ship dates hold it; only the order's own week's request
      // checks it against that week's published snapshot (the others say other_week).
      const decides = x => !!x?.snapshotCheck && x.snapshotCheck.status !== 'other_week';
      if (!prev || String(o.exportedAt || '') > String(prev.exportedAt || '')
          || (String(o.exportedAt || '') === String(prev.exportedAt || '') && decides(o) && !decides(prev))) orders.set(o.orderKey, o);
    }
  }
  return { orders, versions: [...versions.values()] };
}

/**
 * Is the line-item export available for this period? Covered when one export's ship-date window spans
 * the period's order dates (an order ships on or after its order date).
 * @returns {{ available: boolean, reason: string|null, window: {from,to}|null }}
 */
export function apsCoverage(period, versions) {
  if (!versions?.length) return { available: false, window: null,
    reason: 'No ShipStation line-item export has been received for this period yet. The Monday collector adds it automatically.' };
  const from = versions.map(v => v.windowFrom).sort()[0], to = versions.map(v => v.windowTo).sort().reverse()[0];
  const covering = versions.find(v => v.windowFrom <= period.from && v.windowTo >= period.to);
  if (covering) return { available: true, reason: null, window: { from: covering.windowFrom, to: covering.windowTo } };
  return { available: false, window: { from, to },
    reason: `The line-item export covers ship dates ${from} to ${to}, not the whole period (${period.from} to ${period.to}).` };
}

/**
 * Per order with APS lines: quantities, revenue, cost and the APS shipping cost (or the reason it is unknown).
 * @param {object[]} lines   calculator-shaped lines
 * @param {{ mode: 'stored'|'csv', input: Map<orderKey, object>, csvCosts?: Map<orderKey, number> }} o
 */
export function apsOrders(lines, { mode, input, csvCosts = null }) {
  const orders = new Map();
  for (const li of lines || []) {
    const k = key(li.orderNum);
    let o = orders.get(k);
    if (!o) { o = { orderNum: li.orderNum, date: li.date || '', source: li.source || '', apsQty: 0, apsRevenue: 0, apsCogs: 0, cogsKnown: true,
                    products: [], shipPaidSS: null, hasAps: false }; orders.set(k, o); }
    if (known(li.shipPaidSS) && o.shipPaidSS === null) o.shipPaidSS = r2(li.shipPaidSS);
    else if (known(li.shipPaid) && o.shipPaidSS === null && mode === 'csv') o.shipPaidSS = r2(li.shipPaid);
    if (!isApsSku(li.sku)) continue;
    o.hasAps = true;
    o.apsQty += li.qty || 0;
    o.apsRevenue = r2(o.apsRevenue + (li.lineRevenue || 0));
    if (known(li.lineCogs)) o.apsCogs = r2(o.apsCogs + Number(li.lineCogs)); else o.cogsKnown = false;
    const label = String(li.product || li.sku || '').slice(0, 35);
    if (!o.products.includes(label)) o.products.push(label);
  }
  const out = [];
  for (const [k, o] of orders) {
    if (!o.hasAps) continue;
    const m = input?.get(k);
    let ship = null, status = m ? m.status : 'not_in_mapping';
    const allowed = mode === 'csv' ? CSV_COST_STATUSES : APS_COST_STATUSES;   // CSV: the uploaded file gives each label's Rate
    if (m && allowed.has(m.status)) {
      if (mode === 'csv') ship = csvCosts?.has(k) ? r2(csvCosts.get(k)) : null;
      else if (m.status === 'split_matched') {
        // Pinned rows: the reader route checked every ship date of the split against the exact Shipping Cost Report
        // rows the order's published snapshot accepted (snapshotCheck). A matching total alone is never enough; the
        // published expense must also equal the pinned rows' total.
        if (m.snapshotCheck?.status === 'verified' && o.shipPaidSS !== null && Math.round(o.shipPaidSS * 100) === m.scrOrderCents) ship = r2(m.apsCostCents / 100);
        else status = 'split_cost_unverified';
      }
      else ship = o.shipPaidSS;                                  // aps_only: the order's ShipStation expense as published
      if (ship === null && status !== 'split_cost_unverified') status = 'shipping_cost_unknown';
    }
    const cogs = o.cogsKnown ? o.apsCogs : null;
    out.push({ ...o, status, mapping: m || null, apsShipCost: ship, apsCogs: cogs,
      apsGp: cogs !== null && ship !== null ? r2(o.apsRevenue - cogs - ship) : null,
      included: ship !== null && cogs !== null,
      reason: ship === null ? (APS_STATUS_TEXT[status] || 'the order’s ShipStation shipping cost is unknown') : cogs === null ? 'an Air Plant Shop item has no known product cost' : null });
  }
  return out.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.orderNum).localeCompare(String(b.orderNum)));
}

/** Excluded orders grouped by reason (for the disclosure). */
export function apsExclusions(rows) {
  const by = new Map();
  for (const o of rows) if (!o.included) by.set(o.reason, [...(by.get(o.reason) || []), o.orderNum]);
  return [...by.entries()].map(([reason, orders]) => ({ reason, orders }));
}

/** Discount on the 2nd+ APS items, per order. Scenario A: flat $; scenario B: % of the order's average APS item price. */
export function apsDiscount(qty, revenue, { flat = [0, 0, 0], pct = [0, 0, 0] } = {}, scenario = 'A') {
  if (qty <= 1) return 0;
  if (scenario === 'A') { let d = flat[0]; if (qty >= 3) d += flat[1]; if (qty >= 4) d += flat[2] * (qty - 3); return r2(d); }
  const avg = revenue / qty;
  let d = (pct[0] / 100) * avg; if (qty >= 3) d += (pct[1] / 100) * avg; if (qty >= 4) d += (pct[2] / 100) * avg * (qty - 3);
  return r2(d);
}

/** Totals on the included orders only (the same orders before and after). */
export function apsProjection(rows, settings) {
  const inc = rows.filter(o => o.included);
  const rev = r2(inc.reduce((t, o) => t + o.apsRevenue, 0)), gp = r2(inc.reduce((t, o) => t + o.apsGp, 0));
  const scen = s => {
    const disc = r2(inc.reduce((t, o) => t + apsDiscount(o.apsQty, o.apsRevenue, settings, s), 0));
    const newGp = r2(gp - disc), newRev = r2(rev - disc);
    return { discount: disc, gp: newGp, revenue: newRev, margin: newRev > 0 ? Math.round(newGp / newRev * 1000) / 10 : null, delta: r2(newGp - gp) };
  };
  return { orders: inc.length, excluded: rows.length - inc.length, revenue: rev, gp, margin: rev > 0 ? Math.round(gp / rev * 1000) / 10 : null,
           A: scen('A'), B: scen('B') };
}

/**
 * CSV upload: the line-item ShipStation export's Rate per APS-only shipment, summed per order, for orders whose
 * mapping status allows a cost (mixed shipments never get one).
 */
export function csvApsCosts(shipRows, input) {
  const out = new Map(), seen = new Set();
  const pick = (r, names) => { for (const n of names) { const k = Object.keys(r).find(h => h.trim().toLowerCase() === n); if (k !== undefined && String(r[k]).trim() !== '') return r[k]; } return ''; };
  const byShip = new Map();
  for (const r of shipRows || []) {
    const id = String(pick(r, ['shipment #', 'shipment id'])).trim(); if (!id) continue;
    const s = byShip.get(id) || { order: key(pick(r, ['order #', 'order number'])), rate: Number(String(pick(r, ['rate', 'shipping paid'])).replace(/[$,]/g, '')) || 0, skus: [] };
    s.skus.push(String(pick(r, ['item sku', 'sku'])).trim()); byShip.set(id, s);
  }
  for (const [id, s] of byShip) {
    if (seen.has(id)) continue; seen.add(id);
    const m = input.get(s.order);
    if (!m || !CSV_COST_STATUSES.has(m.status)) continue;
    if (!s.skus.length || !s.skus.every(isApsSku)) continue;   // APS-only shipments only
    out.set(s.order, r2((out.get(s.order) || 0) + s.rate));
  }
  return out;
}
