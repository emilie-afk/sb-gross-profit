/**
 * MCG succulent-pack costs (catalog table mcg_pack; corrected costs effective Aug 1, 2026). The SKU's
 * "Total Cost/pack" wins over the rack/pack tier and the name rules and is the final product cost for
 * packs and random/Mystery plants (no volume discount, at any quantity); a SKU listed without a cost
 * stays missing (never $0, never a tier guess); other plants keep their discount rules; a catalog
 * without the table computes exactly as before.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate } from '../shared/calculator.js';
import { engineArgsFromCatalog, CATALOG_TABLES } from '../shared/catalog.js';
import { validateBaseCatalog, BASE_TABLES } from '../shared/catalogOverlay.js';

const PACK = { 'RAKN1499-6': 12, 'RAKN1499-20': null, 'TAKQ1959-25': 41.25, 'XAZZ3141-10': 10, 'S2JN2234': 2 };
const row = (order, sku, name, qty = 1, price = 30) => ({ Name: order, 'Created at': '2026-08-10 10:00:00 -0700', 'Lineitem sku': sku, 'Lineitem name': name,
  'Lineitem quantity': String(qty), 'Lineitem price': String(price), Vendor: 'Succulents Box', 'Financial Status': 'paid', Subtotal: '100', Total: '100', Shipping: '0', 'Source name': 'web' });
const calc = (rows, pack) => calculate(rows, new Map(), { 'XAZZ3141-10': 10, S2KY0001: 4 }, {}, {}, {}, {}, {}, null, {}, null, null, pack === undefined ? {} : { mcgPackCosts: pack });
const by = lines => Object.fromEntries(lines.filter(l => l.sku).map(l => [`${l.orderNum}|${l.sku}`, l]));

test('MCG pack sheet: Total Cost/pack replaces the tier and name rules; listed without a cost stays missing', () => {
  const rows = [row('#1', 'RAKN1499-6', 'Echeveria Pack - 6 Plants'), row('#2', 'RAKN1499-20', 'Echeveria Pack - 20 Plants'),
                row('#3', 'TAKQ1959-25', 'Best Value Succulents Bulk Pack - 25 Plants'), row('#4', 'XAZZ3141-10', 'Succulent Cuttings Assorted Pack - 10')];
  const before = Object.values(by(calc(rows)));
  const after = Object.values(by(calc(rows, PACK)));
  const cost = ls => ls.map(l => [l.sku, l.missingCost ? null : l.lineCogs, l.costSource]);
  assert.deepEqual(cost(before), [['RAKN1499-6', 12, 'MCG tier (Pack 6×$2)'], ['RAKN1499-20', 40, 'MCG tier (Pack 20×$2)'],
    ['TAKQ1959-25', null, 'COST MISSING'], ['XAZZ3141-10', 20, 'MCG tier (Pack 10×$2)']]);
  assert.deepEqual(cost(after), [['RAKN1499-6', 12, 'MCG pack sheet'], ['RAKN1499-20', null, 'MCG pack sheet (cost missing)'],
    ['TAKQ1959-25', 41.25, 'MCG pack sheet'], ['XAZZ3141-10', 10, 'MCG pack sheet']]);
  const missing = after.find(l => l.sku === 'RAKN1499-20');
  assert.equal(missing.missingCost, true, 'a $0 sheet cost is missing, not zero');
  assert.equal(missing.lineCogs, null);
  assert.equal(after.find(l => l.sku === 'TAKQ1959-25').costMatchType, 'mcg_pack_sheet');
});

test('MCG pack sheet: Total Cost/pack is final for packs and random/Mystery plants at every quantity; other plants keep their discount', () => {
  const sheetSkus = [['S2JN2234', 'Mystery Echeveria', 2], ['RAKN1499-6', 'Echeveria Pack - 6 Plants', 12], ['TAKQ1959-25', 'Best Value Succulents Bulk Pack - 25 Plants', 41.25]];
  for (let qty = 1; qty <= 12; qty++) {
    for (const [sku, name, unit] of sheetSkus) {
      // Alone, and in an order with 8 other eligible plants (the top discount tier for those plants).
      for (const others of [0, 8]) {
        const rows = [row('#9', sku, name, qty, 10), ...(others ? [row('#9', 'S2KY0001', 'Some Plant', others, 10)] : [])];
        const l = by(calc(rows, PACK));
        const line = l[`#9|${sku}`];
        assert.equal(line.lineCogs, Math.round(unit * qty * 100) / 100, `${sku} × ${qty} with ${others} other plants`);
        assert.equal(line.costSource, 'MCG pack sheet', 'no volume discount on the sheet cost');
        if (others) {
          // The other plants keep the existing rule; the sheet SKUs do not count toward their tier.
          const other = l['#9|S2KY0001'];
          assert.equal(other.costSource, 'MCG Total sheet (−$0.65/plant vol disc, 8 plants)');
          assert.equal(other.lineCogs, Math.round((4 - 0.65) * 8 * 100) / 100);
        }
      }
    }
  }
  // Mystery plants no longer lift another plant into a discount tier: 4 Mystery + 1 other → the other has none.
  const mixed = by(calc([row('#10', 'S2JN2234', 'Mystery Echeveria', 4, 8), row('#10', 'S2KY0001', 'Some Plant', 1, 10)], PACK));
  assert.equal(mixed['#10|S2KY0001'].costSource, 'MCG Total sheet');
  assert.equal(mixed['#10|S2KY0001'].lineCogs, 4);
  // Without the table, the earlier rules (and discounts) are unchanged.
  const old = by(calc([row('#11', 'S2JN2234', 'Mystery Echeveria', 4, 8)]));
  assert.equal(old['#11|S2JN2234'].costSource, 'MCG tier (2") (−$0.55/plant vol disc, 4 plants)');
  // Listed without a cost: missing at every quantity, never zero.
  for (let qty = 1; qty <= 12; qty++) assert.equal(by(calc([row('#12', 'RAKN1499-20', 'Echeveria Pack - 20 Plants', qty)], PACK))['#12|RAKN1499-20'].missingCost, true);
});

test('MCG pack sheet: bundles resolve their parts through it; without the table nothing changes', () => {
  const rows = [row('#6', 'RAKN1499-6+XAZZ3141-10', 'Bundle'), row('#7', 'RAKN1499-20+XAZZ3141-10', 'Bundle'), row('#8', 'S2KY0001', 'Some Plant')];
  const now = by(calc(rows, PACK));
  assert.equal(now['#6|RAKN1499-6+XAZZ3141-10'].lineCogs, 22);
  assert.equal(now['#7|RAKN1499-20+XAZZ3141-10'].missingCost, true, 'one missing part makes the bundle missing');
  const strip = ls => JSON.stringify(ls);
  assert.equal(strip(calc(rows)), strip(calc(rows, null)), 'null table = earlier rules');
  assert.equal(strip(calc(rows)), strip(calc(rows, {})), 'empty table = earlier rules');
});

test('MCG pack sheet: a catalog table the engine, uploads and overlay bases carry', () => {
  assert.ok(CATALOG_TABLES.includes('mcg_pack') && BASE_TABLES.includes('mcg_pack'));
  assert.deepEqual(engineArgsFromCatalog({ tables: { mcg_pack: PACK } }).mcgPackCosts, PACK);
  assert.equal(engineArgsFromCatalog({ tables: {} }).mcgPackCosts, null);
  const base = t => validateBaseCatalog({ tables: { mcg_total: { X: 1 }, mcg_pack: t } });
  assert.equal(base(PACK).accepted, true);
  assert.equal(base({ A: 0 }).accepted, false, 'a zero cost is refused: missing is null');
  assert.equal(base({ A: 'x' }).accepted, false);
});
