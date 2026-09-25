/**
 * Fixed synthetic week for the financial-engine golden hash (see golden.test.mjs).
 * Invented order numbers, SKUs and amounts only.
 */
import { createHash } from 'node:crypto';
import { buildSnapshot } from '../shared/snapshot.js';
import { csvRowsToNormalizedOrders } from '../shared/adapters/legacy.js';
import { normalizeShopifyOrders } from '../shared/adapters/shopifyGraphql.js';
import { normalizeShipStationRows } from '../shared/adapters/shipstation.js';
import { csvOrder, gqlOrder, ssCustom, FIXTURE_CATALOG } from './fixtures-normalized.mjs';

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

export function goldenSnapshot() {
  const csvRows = [
    ...csvOrder({ name: '#900101', subtotal: 30, shipping: 7.99, taxes: 2.1, total: 40.09,
      lines: [{ sku: 'MG-ALOE', price: 12, qty: 1, vendor: 'Succulents Box' }, { sku: 'MG-JADE', price: 18, qty: 1, vendor: 'Succulents Box' }] }),
    ...csvOrder({ name: '#900102', subtotal: 27, shipping: 0, taxes: 0, total: 24.3, discountAmount: 2.7,
      lines: [{ sku: 'AS-TILL', price: 9, qty: 3, discount: 2.7, vendor: 'Air Plant Shop' }] }),
    ...csvOrder({ name: '#900103', subtotal: 45, shipping: 9.5, taxes: 3.6, total: 58.1, refunded: 10,
      lines: [{ sku: 'FH-POTHOS', price: 45, qty: 1, vendor: 'House Plant Dropship' }] }),
    ...csvOrder({ name: '#900104', subtotal: 39.6, shipping: 5, taxes: 0, total: 44.6,
      lines: [{ sku: 'LM-VASE-PRO-BUD-RAINBOW', price: 39.6, qty: 1, vendor: 'LindaMakes' }, { sku: 'UNKNOWN-1', price: 0, qty: 1 }] }),
  ];
  const gql = normalizeShopifyOrders([
    gqlOrder({ name: '#900105', createdAt: '2026-09-16T18:00:00Z', subtotal: 24, shipping: 6, taxes: 1.5, total: 31.5, discounts: 0,
      lines: [{ sku: 'MG-ALOE', price: 12, qty: 2, vendor: 'Succulents Box',
        allocations: [{ amount: 2.4, code: 'TEST10' }] }] }),
  ], { timeZone: 'America/Los_Angeles' });
  const orders = [...csvRowsToNormalizedOrders(csvRows), ...gql];
  const { shipments } = normalizeShipStationRows([
    ...ssCustom({ shipment: 'S101', order: '900101', fee: '6.25', items: [{ sku: 'MG-ALOE', qty: 1 }, { sku: 'MG-JADE', qty: 1 }] }),
    ...ssCustom({ shipment: 'S102', order: '900102', fee: '', rate: '4.10', items: [{ sku: 'AS-TILL', qty: 3 }] }),
    ...ssCustom({ shipment: 'S104', order: '900104', fee: '0', rate: '', items: [{ sku: 'LM-VASE-PRO-BUD-RAINBOW', qty: 1 }] }),
    ...ssCustom({ shipment: 'S105', order: '900105', fee: '5.40', insurance: '1.25', items: [{ sku: 'MG-ALOE', qty: 2 }] }),
  ]);
  return buildSnapshot({ weekStart: '2026-09-14', orders, shipments, catalog: FIXTURE_CATALOG });
}

export const goldenHash = () => createHash('sha256').update(stable(goldenSnapshot())).digest('hex');

