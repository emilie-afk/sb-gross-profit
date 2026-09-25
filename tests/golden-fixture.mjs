/**
 * Fixed synthetic week for the financial-engine golden hash (see golden.test.mjs).
 * CSV orders only (there is no Shopify API path). Invented order numbers and amounts.
 */
import { createHash } from 'node:crypto';
import { buildSnapshot } from '../shared/snapshot.js';
import { csvRowsToNormalizedOrders } from '../shared/adapters/legacy.js';
import { normalizeShipStationRows } from '../shared/adapters/shipstation.js';
import { csvOrder, ssCustom, FIXTURE_CATALOG } from './fixtures-normalized.mjs';

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

function goldenInputs() {
  const csvRows = [
    ...csvOrder({ name: '#900101', subtotal: 30, shipping: 7.99, taxes: 2.1, total: 40.09,
      lines: [{ sku: 'MG-ALOE', price: 12, qty: 1, vendor: 'Succulents Box' }, { sku: 'MG-JADE', price: 18, qty: 1, vendor: 'Succulents Box' }] }),
    ...csvOrder({ name: '#900102', subtotal: 27, shipping: 0, taxes: 0, total: 24.3, discountAmount: 2.7,
      lines: [{ sku: 'AS-TILL', price: 9, qty: 3, discount: 2.7, vendor: 'Air Plant Shop' }] }),
    ...csvOrder({ name: '#900103', subtotal: 45, shipping: 9.5, taxes: 3.6, total: 58.1, refunded: 10,
      lines: [{ sku: 'FH-POTHOS', price: 45, qty: 1, vendor: 'House Plant Dropship' }] }),
    ...csvOrder({ name: '#900104', subtotal: 39.6, shipping: 5, taxes: 0, total: 44.6,
      lines: [{ sku: 'LM-VASE-PRO-BUD-RAINBOW', price: 39.6, qty: 1, vendor: 'LindaMakes' }, { sku: 'UNKNOWN-1', price: 0, qty: 1 }] }),
    ...csvOrder({ name: '#900105', createdAt: '2026-09-16 11:00:00 -0700', subtotal: 21.6, shipping: 6, taxes: 1.5, total: 29.1,
      discountAmount: 2.4, lines: [{ sku: 'MG-ALOE', price: 12, qty: 2, discount: 2.4, vendor: 'Succulents Box' }] }),
  ];

  const orders = csvRowsToNormalizedOrders(csvRows);
  const { shipments } = normalizeShipStationRows([
    ...ssCustom({ shipment: 'S101', order: '900101', fee: '6.25', items: [{ sku: 'MG-ALOE', qty: 1 }, { sku: 'MG-JADE', qty: 1 }] }),
    ...ssCustom({ shipment: 'S102', order: '900102', fee: '', rate: '4.10', items: [{ sku: 'AS-TILL', qty: 3 }] }),
    ...ssCustom({ shipment: 'S104', order: '900104', fee: '0', rate: '', items: [{ sku: 'LM-VASE-PRO-BUD-RAINBOW', qty: 1 }] }),
    ...ssCustom({ shipment: 'S105', order: '900105', fee: '5.40', insurance: '1.25', items: [{ sku: 'MG-ALOE', qty: 2 }] }),
  ]);
  return { orders, shipments };
}

/** Revision 8 compatibility (mapping-export source, legacy rules). */
export function goldenSnapshot() {
  const { orders, shipments } = goldenInputs();
  return buildSnapshot({ weekStart: '2026-09-14', orders, shipments, catalog: FIXTURE_CATALOG });
}

/**
 * C3: the same week with a synthetic Shipping Cost Report (Shipping Cost
 * summed per Shopify order; order 900104 has no row, 900102 has two rows).
 */
export const GOLDEN_C3_REPORT = new Map([
  ['900101', { orderKey: '900101', costCents: 612, rowCount: 1, firstShipDate: '2026-09-15', lastShipDate: '2026-09-15' }],
  ['900102', { orderKey: '900102', costCents: 870, rowCount: 2, firstShipDate: '2026-09-15', lastShipDate: '2026-09-16' }],
  ['900105', { orderKey: '900105', costCents: 540, rowCount: 1, firstShipDate: '2026-09-17', lastShipDate: '2026-09-17' }],
]);
export function goldenSnapshotC3() {
  const { orders } = goldenInputs();
  return buildSnapshot({ weekStart: '2026-09-14', orders, catalog: FIXTURE_CATALOG, shippingSource: 'shipping_cost_report',
                         shippingCostReport: GOLDEN_C3_REPORT, c3: { asOf: '2026-09-21T09:00:00Z', unmatchedReportOrders: 0 } });
}

/** The engine-version label is normalized so the pin tracks behaviour only. */
export const REVISION8_ENGINE_VERSION = '2026.09.24-phase1';
const hashOf = snap => createHash('sha256').update(stable(snap)).digest('hex');
export const goldenHash = () => hashOf({ ...goldenSnapshot(), engineVersion: REVISION8_ENGINE_VERSION });
export const C3_ENGINE_VERSION = '2026.09.25-c3';
export const goldenHashC3 = () => hashOf({ ...goldenSnapshotC3(), engineVersion: C3_ENGINE_VERSION });
