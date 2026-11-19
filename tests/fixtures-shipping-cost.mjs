/**
 * Synthetic ShipStation Shipping Cost Report rows (raw 18-column shape).
 * Invented order numbers, recipients and amounts only. Reproduces the verified
 * real-file shapes: M/D/YYYY 12:00:00 AM dates, 6-digit order numbers,
 * multi-row orders repeating the same Shipping Paid, zero-paid rows with real
 * cost, and a Recipient column that must never leave the collector.
 */
import { SHIPPING_COST_REPORT_RAW_COLUMNS } from '../shared/adapters/shippingCostReport.js';
import { addDays } from '../shared/normalized.js';

export const usDate = iso => { const [y, m, d] = iso.split('-').map(Number); return `${m}/${d}/${y} 12:00:00 AM`; };

export function reportRow({ date = '2026-08-10', order = '900101', cost = '6.25', paid = '7.99', provider = 'Stamps.com', service = 'GA',
  items = '1', weight = '12.00', insurance = '0', recipient = 'SYNTHETIC RECIPIENT', store = 'Succulents Box (Shopify)', extra = {} } = {}) {
  const pm = (Number(paid) - Number(cost)).toFixed(2);
  const row = {
    'Ship Date': date.includes('/') ? date : usDate(date), 'Recipient': recipient, 'Order #': order, 'Provider': provider, 'Service': service,
    'Package': 'Pkg', 'Items': items, 'Zone': '5', 'Shipping Paid': paid, 'Shipping Cost': cost, 'Insurance Cost': insurance,
    'Weight': weight, 'Weight Unit': 'Ounce', 'Store': store, 'Duties': '0', 'Taxes': '0', 'Import Fee': '0', '+/-': pm, ...extra,
  };
  const o = {}; for (const c of SHIPPING_COST_REPORT_RAW_COLUMNS) o[c] = row[c];
  for (const [k, v] of Object.entries(extra)) o[k] = v;
  return o;
}

/** A multi-row order: Shipping Paid repeats on every row (verified real behaviour). */
export const multiRowOrder = (order, date, costs, paid = '9.99') => costs.map(c => reportRow({ order, date, cost: c, paid }));

const isWeekday = iso => { const d = new Date(`${iso}T00:00:00Z`).getUTCDay(); return d >= 1 && d <= 5; };

/**
 * Rows for every weekday in [from, to]: two orders per day with deterministic
 * costs, so two reports covering the same dates contain identical rows.
 */
export function rollingRows(from, to) {
  const rows = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (!isWeekday(d)) continue;                        // weekends ship nothing: zero rows is not a gap
    const n = Number(d.replace(/-/g, '').slice(2));     // e.g. 260810
    rows.push(reportRow({ date: d, order: String(900000 + (n % 100000)).slice(-6), cost: (5 + (n % 7)).toFixed(2) }));
    rows.push(reportRow({ date: d, order: String(800000 + (n % 100000)).slice(-6), cost: (4.5 + (n % 5)).toFixed(2), paid: '0' }));
  }
  return rows;
}
