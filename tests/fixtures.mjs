/** Shared fixtures for the scenario + calculator tests. */

export const VENDOR_COSTS = {
  'L2G': {
    'HOPE BOX': { unitCost: 29.99, sku: 'Hope Box', productName: 'Hope Gift Box',
                  source: 'L2G sheet', matchType: 'exact_sku' },
  },
  'LG': {
    'QLR_FERN_4IN1': { unitCost: 30.90, sku: 'QLR_FERN_4IN1',
                     productName: 'Fiddle Leaf Fig Tree (Ficus Lyrata)',
                     source: 'LG sheet', matchType: 'exact_sku' },
  },
  'CC': {
    'QCC-CX-HYSDT-PNS': { unitCost: 22.5, sku: 'QCC-CX-HYSDT-PNS',
                         productName: 'White Watering Can - Plant Dad',
                         source: 'CC sheet', matchType: 'exact_sku' },
  },
  'SA': {
    'QSA-EBHWD-PERMU': { unitCost: 40.0, sku: 'QSA-EBHWD-PERMU', productName: 'Small Heart',
                         source: 'SA sheet', matchType: 'exact_sku' },
    // A real SA SKU containing a '+' — one product, not a bundle.
    'QSA-KRZDBMAY-XKRMLGP+DONKEY': { unitCost: 19.0, sku: 'QSA-KRZDBMAY-XKRMLGP+DONKEY',
                         productName: 'White Pot - Rosettes + Donkey Tail',
                         source: 'SA sheet', matchType: 'exact_sku' },
  },
  'LM': {
    'QLM-TVWZ-VMS-ALD-DRFKXGH': { unitCost: 19.8, sku: 'QLM-TVWZ-VMS-ALD-DRFKXGH',
                         productName: 'Rainbow Bud Vase',
                         source: 'LM sheet', matchType: 'exact_sku' },
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
