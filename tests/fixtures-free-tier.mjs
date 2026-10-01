// Synthetic Free-tier parity datasets (invented order numbers, SKUs and amounts; no real data).
// Route lines, discounts, refunds, cancellations, missing-cost SKUs, several vendors, HPD records,
// near-midnight orders and orders in DST hours; 1–3 report rows per order, cross-week shipping,
// awaiting-cost orders and report orders that match no Shopify order.
import { csvOrder, ssCustom } from './fixtures-normalized.mjs';
import { reportRow } from './fixtures-shipping-cost.mjs';
import { addDays } from '../shared/normalized.js';
import { catalog } from '../worker/test/helpers.mjs';

const SKUS = [['MG-ALOE', 'Succulents Box'], ['MG-JADE', 'Succulents Box'], ['FH-POTHOS', 'Succulents Box'], ['LIV-1', 'Live to Give'],
  ['CAL-7', 'Calathea Collective'], ['LIN-3', 'LindaMakes'], ['NOPE-9', 'Nobody'], ['SUR-2', 'Surfside Arrangement']];
const ROUTE = { sku: 'ROUTEINS', name: 'Shipping Protection by Route - 0.98', price: 0.98, vendor: 'Route' };
const pad = (n, w) => String(n).padStart(w, '0');
const us = iso => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;

/** Local wall time with the correct Los Angeles offset for that instant (DST aware). */
function laStamp(day, minuteOfDay) {
  const h = Math.floor(minuteOfDay / 60), m = minuteOfDay % 60;
  for (const off of ['-0700', '-0800']) {
    const iso = `${day}T${pad(h, 2)}:${pad(m, 2)}:00${off.slice(0, 3)}:${off.slice(3)}`;
    const back = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .format(new Date(iso)).replace(', ', 'T');
    if (back === `${day}T${pad(h, 2)}:${pad(m, 2)}`) return `${day} ${pad(h, 2)}:${pad(m, 2)}:00 ${off}`;
  }
  return null;                                          // nonexistent local time (spring-forward gap)
}

/**
 * n orders spread over `days` days from `from`. Includes Route lines, discounts,
 * refunds, cancellations, missing-cost SKUs, multi-vendor lines, orders within
 * minutes of local midnight (both sides), and orders on DST transition days.
 */
export function shopifyRows({ n, from, days, prefix, seed = 0 }) {
  const rows = [], meta = [];
  for (let i = 0; i < n; i++) {
    const day = addDays(from, Math.floor((i * days) / n));
    const k = i + seed;
    let minute = [5, 1435, 1439, 0, 125, 181, 610, 900][k % 8] + (k % 3);        // near-midnight and 01:xx–03:xx (DST hours)
    minute = Math.min(minute, 1439);
    let stamp = laStamp(day, minute); if (!stamp) stamp = laStamp(day, minute + 60);
    const nl = 1 + (k % 4);
    const lines = Array.from({ length: nl }, (_, j) => { const [sku, vendor] = SKUS[(k + j * 3) % SKUS.length];
      return { sku, price: 6 + ((k + j) % 9) + (j % 2 ? 0.49 : 0), qty: 1 + ((k + j) % 3), vendor, discount: k % 6 === 0 && j === 0 ? 1.5 : 0 }; });
    if (k % 5 === 0) lines.push({ ...ROUTE });
    const sub = +lines.reduce((s, l) => s + l.price * (l.qty || 1) - (l.discount || 0), 0).toFixed(2);
    const ship = k % 11 === 0 ? 0 : 5.99, tax = +(sub * 0.0725).toFixed(2);
    const name = `#${prefix}${pad(i, 5)}`;
    rows.push(...csvOrder({ name, createdAt: stamp, subtotal: sub, shipping: ship, taxes: tax, total: +(sub + ship + tax).toFixed(2),
      discountAmount: k % 6 === 0 ? 1.5 : 0, refunded: k % 37 === 0 ? +(sub / 3).toFixed(2) : 0,
      cancelledAt: k % 101 === 0 ? stamp : '', source: k % 13 === 0 ? 'sellbrite' : k % 19 === 0 ? 'tiktok' : 'web', tags: k % 17 === 0 ? 'wholesale' : '', noteAttributes: k % 23 === 0 ? 'Channel: Amazon' : '', lines })
      .map(r => ({ ...r, 'Fulfilled at': '' })));
    meta.push({ name, number: name.slice(1), day, hasPothos: lines.some(l => l.sku === 'FH-POTHOS'), k });
  }
  return { rows, meta };
}

/** Shipping Cost Report rows for the orders: 1–3 rows each, some ship next week, some not yet shipped, plus unmatched orders. */
export function scrRows(meta, { lastDay, costShift = 0, skipEvery = 29, zeroEvery = 53, extraUnmatched = 12, unmatchedPrefix = '99' }) {
  const out = [];
  for (const o of meta) {
    if (o.k % skipEvery === 0) continue;                                // awaiting shipping cost
    const shipDay = addDays(o.day, (o.k % 4 === 3) ? 6 : (o.k % 3));    // some ship in the following week
    if (shipDay > lastDay) continue;
    const nr = o.k % 10 === 0 ? 3 : o.k % 7 === 0 ? 2 : 1;
    for (let r = 0; r < nr; r++) {
      const cost = o.k % zeroEvery === 0 ? '0.00' : (3.5 + ((o.k + r) % 13) * 0.61 + costShift).toFixed(2);
      out.push(reportRow({ date: us(r === 2 ? addDays(shipDay, 1) > lastDay ? shipDay : addDays(shipDay, 1) : shipDay), order: o.number, cost, paid: '5.99',
        insurance: '0', items: String(1 + r) }));
    }
  }
  const first = meta[0].day;
  for (let u = 0; u < extraUnmatched; u++) out.push(reportRow({ date: us(addDays(first, (u * 5) % 50)), order: `${unmatchedPrefix}${pad(u, 4)}`, cost: (4 + u * 0.1).toFixed(2), paid: '0' }));
  return out;
}

export function shipstationRows(meta) {
  return meta.filter(o => o.k % 2 === 0).flatMap(o => ssCustom({ shipment: `SH-${o.number}`, order: o.number, fee: o.k % 20 === 0 ? '0' : '5.10',
    rate: o.k % 20 === 0 ? '0' : '5.40', insurance: o.k % 10 === 0 ? '1.00' : '', items: [{ sku: 'MG-ALOE', qty: 1 }] }));
}

export function hpdOrders(meta) {
  return meta.filter(o => o.hasPothos && o.k % 3 === 0).map((o, j) => ({ shopifyOrderNumber: o.number, hpdOrderNumber: `HPD${pad(j, 5)}`,
    orderDate: o.day, carrierService: 'USPS Priority', netTerms: j % 4 === 0 ? null : +(7.25 + (j % 5)).toFixed(2), prepaid: 8.5,
    costDifference: j % 4 === 0 ? null : +((7.25 + (j % 5)) - 8.5).toFixed(2), items: [{ sku: 'FH-POTHOS', qty: 1 }] }));
}

export function catalogCandidate() {
  const c = catalog();
  c.tables.vendor_costs['Calathea Collective']['CAL-7'] = { unitCost: 11.25 };
  c.tables.vendor_costs['Live to Give']['LIV-1'] = { unitCost: 3.4 };
  c.tables.vendor_costs['LindaMakes']['LIN-3'] = { unitCost: 19.8 };
  c.tables.vendor_costs['Surfside Arrangement']['SUR-2'] = { unitCost: 22 };
  c.tables.hp_supplement['FH-POTHOS'] = 9;
  return c;
}
