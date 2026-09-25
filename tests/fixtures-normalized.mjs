/**
 * Synthetic fixtures for the normalized pipeline. Invented order numbers, SKUs
 * and amounts only — no customer, order or shipment data from any real export.
 */
import { row, ssRow } from './fixtures.mjs';

const money = n => ({ shopMoney: { amount: String(n) } });

/** A GraphQL order node in the shape SHOPIFY_ORDERS_QUERY returns. */
export function gqlOrder({ name = '#900001', createdAt = '2026-09-15T17:04:12Z', cancelledAt = null,
  subtotal, shipping = 0, taxes = 0, total, discounts = 0, refunded = 0, sourceName = 'web',
  tags = [], attrs = [], lines = [], refunds = [] } = {}) {
  return {
    id: `gid://shopify/Order/${name.replace('#', '')}`,
    name, createdAt, cancelledAt, tags, sourceName, discountCodes: [],
    customAttributes: attrs,
    subtotalPriceSet: money(subtotal), totalShippingPriceSet: money(shipping), totalTaxSet: money(taxes),
    totalPriceSet: money(total), totalDiscountsSet: money(discounts), totalRefundedSet: money(refunded),
    originalTotalDutiesSet: money(0),
    lineItems: { nodes: lines.map((l, i) => ({
      id: l.id || `gid://shopify/LineItem/${name.replace('#', '')}${i}`,
      sku: l.sku, name: l.name || l.sku, quantity: l.qty ?? 1, currentQuantity: l.currentQty ?? l.qty ?? 1,
      requiresShipping: l.requiresShipping ?? true, vendor: l.vendor || '',
      originalUnitPriceSet: money(l.price),
      discountAllocations: (l.allocations || []).map(a => ({
        allocatedAmountSet: money(a.amount),
        discountApplication: { __typename: 'DiscountCodeApplication', index: 0, allocationMethod: a.method || 'ACROSS',
          targetSelection: 'ALL', targetType: 'LINE_ITEM', code: a.code || 'TEST10' },
      })),
    })) },
    refunds: refunds.map((rf, i) => ({
      id: `gid://shopify/Refund/${name.replace('#', '')}${i}`, createdAt, totalRefundedSet: money(rf.amount),
      refundLineItems: { nodes: (rf.lines || []).map(rl => ({
        lineItem: { id: `gid://shopify/LineItem/${name.replace('#', '')}${rl.lineIndex}` }, quantity: rl.qty ?? 1,
        subtotalSet: money(rl.subtotal), totalTaxSet: money(0) })) },
      refundShippingLines: { nodes: (rf.shipping || []).map(s => ({ subtotalAmountSet: money(s), taxAmountSet: money(0) })) },
      orderAdjustments: { nodes: [] },
    })),
  };
}

/** Shopify CSV rows for one order: order-level columns on the first row only, as Shopify writes them. */
export function csvOrder({ name = '#900001', createdAt = '2026-09-15 10:04:12 -0700', subtotal, shipping = 0, taxes = 0,
  total, discountAmount = 0, refunded = 0, source = 'web', tags = '', noteAttributes = '', cancelledAt = '', lines = [] }) {
  return lines.map((l, i) => {
    const r = row({
      'Name': name, 'Created at': createdAt,
      'Lineitem quantity': String(l.qty ?? 1), 'Lineitem name': l.name || l.sku, 'Lineitem price': String(l.price),
      'Lineitem sku': l.sku, 'Lineitem discount': String(l.discount ?? 0), 'Vendor': l.vendor || '',
      'Lineitem requires shipping': l.requiresShipping === false ? 'false' : 'true',
    });
    if (i === 0) Object.assign(r, {
      'Subtotal': String(subtotal), 'Shipping': String(shipping), 'Taxes': String(taxes), 'Total': String(total),
      'Discount Amount': String(discountAmount), 'Refunded Amount': String(refunded), 'Source': source,
      'Tags': tags, 'Note Attributes': noteAttributes, 'Cancelled at': cancelledAt,
    });
    else Object.assign(r, {
      'Subtotal': '', 'Shipping': '', 'Taxes': '', 'Total': '', 'Discount Amount': '', 'Refunded Amount': '',
      'Source': '', 'Tags': '', 'Note Attributes': '', 'Cancelled at': '', 'Financial Status': '', 'Discount Code': '',
    });
    return r;
  });
}

/** Custom ShipStation export rows (one per item). */
export function ssCustom({ shipment = 'S1', order = '900001', fee = '', rate = '', insurance = '', paid = '0',
  voided = 'false', items = [{ sku: 'SKU', qty: 1 }], extra = {} }) {
  return items.map(it => ({
    'Shipment ID': shipment, 'Order Number': order, 'Tracking Number': '9400000000000000000000',
    'Ship Date': '09/16/2026', 'Carrier Fee': String(fee), 'Rate': String(rate), 'Insurance Cost': String(insurance),
    'Shipping Paid': String(paid), 'Void Flag': voided, 'Provider Name': 'stamps_com', 'Created By': 'packer1',
    'Item SKU': it.sku, 'Item Quantity': String(it.qty), 'Recipient': 'SYNTHETIC RECIPIENT', ...extra,
  }));
}

/** Cost catalog that prices the fixture SKUs through the engine's manual-cost path. */
export const FIXTURE_CATALOG = Object.freeze({
  rev: 'cat_fixture',
  tables: {
    mcg_total: { 'PLACEHOLDER': 1 }, product_costs: {}, sku_weights: {}, sb_costs: {},
    hp_supplement: { 'MG-ALOE': 4.5, 'MG-JADE': 6, 'AS-TILL': 3, 'FH-POTHOS': 9 },
    hp_by_name: {}, sku_alias: {},
    vendor_costs: { 'LindaMakes': { 'LM-VASE-PRO-BUD-RAINBOW': { unitCost: 19.8, sku: 'LM-VASE-PRO-BUD-RAINBOW',
      productName: 'Rainbow Bud Vase', source: 'LindaMakes sheet', matchType: 'exact_sku' } } },
    vendor_index: { 'LindaMakes': { byLooseSku: {}, byName: {} } },
  },
  mcgExtra: {},
});

export { row, ssRow };

/** ssCustom rows reshaped to the saved mapping-export template (exact columns: no Recipient, no Created By). */
export function ssTemplate(opts) {
  return ssCustom(opts).map(({ Recipient, 'Created By': _createdBy, 'Provider Name': provider, ...r }) => ({ ...r, Provider: provider }));
}
