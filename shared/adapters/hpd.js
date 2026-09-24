/**
 * hpd.js — House Plant Dropship shipping log → normalized HPD orders
 * ==================================================================
 * Same logic as parseHpdLog() in calculator.js (which stays, unchanged, for
 * manual uploads), with data minimization for storage:
 *
 *   - The Shopify order number is extracted from "Notes - From Buyer", exactly
 *     as parseHpdLog() does, and the notes text itself is then discarded. It is
 *     free text written by the buyer.
 *   - "Ship To - State" is not kept; no calculation reads it.
 *   - Net Terms appears only on the first item row of an HPD order; the first
 *     non-blank value wins, as in parseHpdLog().
 */
import { toMoney } from '../normalized.js';

const COLS = {
  date:     'Date - Order Date',
  order:    'Order - Number',
  carrier:  'Carrier - Service Selected',
  qty:      'Item - Qty',
  sku:      'Item - SKU',
  notes:    'Notes - From Buyer',
  net:      'Actual Net Terms Cost (Labor + Carrier Shipping)',
  prepaid:  'Prepaid Fixed Price',
  diff:     'Cost Difference (Net Terms - Prepaid)',
};

/** Rows keyed by header (from parseCSV) → NormalizedHpdOrder[] */
export function normalizeHpdRows(rows) {
  const pick = (r, name) => {
    const k = Object.keys(r).find(h => h.trim() === name);
    return k === undefined ? '' : String(r[k] ?? '');
  };
  const byShopify = new Map();
  const hpdToShopify = new Map();
  for (const r of rows) {
    const hpdOrder = pick(r, COLS.order).trim();
    if (!hpdOrder) continue;                                  // summary / total rows
    let shopifyNum = hpdToShopify.get(hpdOrder) || '';
    if (!shopifyNum) {
      const m = pick(r, COLS.notes).match(/#(\d+)/);
      if (m) { shopifyNum = m[1]; hpdToShopify.set(hpdOrder, shopifyNum); }
    }
    if (!shopifyNum) continue;
    const net = toMoney(pick(r, COLS.net)), prepaid = toMoney(pick(r, COLS.prepaid)), diff = toMoney(pick(r, COLS.diff));
    if (!byShopify.has(shopifyNum)) {
      byShopify.set(shopifyNum, {
        shopifyOrderNumber: shopifyNum,
        hpdOrderNumber:     hpdOrder,
        orderDate:          pick(r, COLS.date).trim(),
        carrierService:     pick(r, COLS.carrier).trim(),
        netTerms: null, prepaid: null, costDifference: null,
        items: [],
      });
    }
    const e = byShopify.get(shopifyNum);
    if (e.netTerms === null && net !== null) { e.netTerms = net; e.prepaid = prepaid; e.costDifference = diff; }
    e.items.push({ sku: pick(r, COLS.sku).trim(), qty: parseInt(pick(r, COLS.qty) || '1', 10) || 1 });
  }
  return [...byShopify.values()];
}

export const HPD_COLUMNS = COLS;
