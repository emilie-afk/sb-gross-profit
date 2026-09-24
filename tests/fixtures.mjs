/** Shared fixtures for the scenario + calculator tests. */

export const VENDOR_COSTS = {
  'Live to Give': {
    'PRAY DLX': { unitCost: 29.99, sku: 'Pray DLX', productName: 'Prayer Gift Box',
                  source: 'Live to Give sheet', matchType: 'exact_sku' },
  },
  'Lively Good': {
    'PL_FLF_4IN1': { unitCost: 33.54, sku: 'PL_FLF_4IN1',
                     productName: 'Fiddle Leaf Fig Tree (Ficus Lyrata)',
                     source: 'Lively Good sheet', matchType: 'exact_sku' },
  },
  'Calathea Collective': {
    'CC-WC-PLANT-DAD': { unitCost: 22.5, sku: 'CC-WC-PLANT-DAD',
                         productName: 'White Watering Can - Plant Dad',
                         source: 'Calathea Collective sheet', matchType: 'exact_sku' },
  },
  'Surfside Arrangement': {
    'SUR-HEART-SMALL': { unitCost: 40.0, sku: 'SUR-HEART-SMALL', productName: 'Small Heart',
                         source: 'Surfside Arrangement sheet', matchType: 'exact_sku' },
    // A real Surfside SKU containing a '+' — one product, not a bundle.
    'SUR-WHITEPOT-ROSETTE+DONKEY': { unitCost: 19.0, sku: 'SUR-WHITEPOT-ROSETTE+DONKEY',
                         productName: 'White Pot - Rosettes + Donkey Tail',
                         source: 'Surfside Arrangement sheet', matchType: 'exact_sku' },
  },
  'LindaMakes': {
    'LM-VASE-PRO-BUD-RAINBOW': { unitCost: 19.8, sku: 'LM-VASE-PRO-BUD-RAINBOW',
                         productName: 'Rainbow Bud Vase',
                         source: 'LindaMakes sheet', matchType: 'exact_sku' },
  },
};

/** Build a Shopify order-export row with sane defaults. */
export function row(over = {}) {
  return {
    'Name': '#100001',
    'Financial Status': 'paid',
    'Subtotal': '0',
    'Shipping': '0',
    'Taxes': '0',
    'Total': '0',
    'Discount Code': '',
    'Discount Amount': '0',
    'Created at': '2026-07-05 10:00:00 -0700',
    'Lineitem quantity': '1',
    'Lineitem name': 'Product',
    'Lineitem price': '0',
    'Lineitem sku': 'SKU',
    'Lineitem requires shipping': 'true',
    'Cancelled at': '',
    'Refunded Amount': '0',
    'Vendor': '',
    'Source': 'web',
    'Lineitem discount': '0',
    ...over,
  };
}

/** ShipStation line-items rows (cost repeats on every item row of a shipment). */
export function ssRow(over = {}) {
  return {
    'Shipment #': 'S1',
    'Order #': '100001',
    'Shipping Paid': '0',
    'Item Quantity': '1',
    'Item SKU': 'SKU',
    ...over,
  };
}

export const EMPTY_COSTS = { mcg: {}, product: {}, weights: {}, additional: {}, hpByName: {}, alias: {} };
