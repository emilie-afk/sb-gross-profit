/**
 * Scenarios models (js/scenarioModels.js), the same code the dashboard runs for CSV and saved reports:
 *  - MCG volume discount: only individual plants are eligible, by the engine's own rule. Packs and
 *    random/Mystery plants on the MCG pack sheet get no projected savings, alone or in a mixed order.
 *  - Price projection: costs come from the engine's shared resolver (MCG pack sheet included); an
 *    unknown cost stays unknown (never $0) and profit is marked incomplete.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mcgVolumeOrders, mcgVolumeSavings, hasPackTable, projectionUnitCost, projectionTotals, packDependent, markPackDependentUnknown, PACK_TABLE_MISSING } from '../js/scenarioModels.js';
import { calculate } from '../shared/calculator.js';

const STORE = 'Succulents Box (17381)';
// Pack sheet: a pack, a random plant and a single Mystery plant, all with ordinary MCG prefixes, so only
// the pack-sheet rule (not a rack prefix) keeps them out of the discount. One sheet SKU has no cost.
const PACK = { 'S2PK1001-10': 18, 'C2RD2002': 3.5, 'S3MY3003': 2, 'CXNO4004': null };
const L = (orderNum, sku, qty, o = {}) => ({ orderNum, sku, qty, store: STORE, lineRevenue: 10 * qty, lineNetGp: 4 * qty, lineCogs: 6 * qty, ...o });

test('MCG volume discount: a mixed order counts only its individual plants; packs and random/Mystery plants get nothing', () => {
  const lines = [
    // Mixed: 3 individual plants + a pack, a random plant and a Mystery plant (2 units).
    L('#1', 'S2KY1048', 2), L('#1', 'CXVY6173', 1), L('#1', 'S2PK1001-10', 1), L('#1', 'C2RD2002', 1), L('#1', 'S3MY3003', 2),
    // Packs only: no eligible plant, so in no tier and no savings (the reproduced $1 case).
    L('#2', 'S2PK1001-10', 1),
    // Random/Mystery only, several units.
    L('#3', 'S3MY3003', 4), L('#3', 'C2RD2002', 3),
    // A bundle holding a pack-sheet SKU is excluded like the engine does.
    L('#4', 'S2KY1048+S3MY3003', 1), L('#4', 'S1AB1234', 1),
    // Not Succulents Box: never in the model.
    L('#5', 'S2KY1048', 5, { store: 'Live to Give' }),
  ];
  const v = mcgVolumeOrders(lines, PACK);
  assert.deepEqual([...v.orders.keys()], ['#1', '#4']);
  assert.equal(v.orders.get('#1').plants, 3, 'only the 3 individual plants of the mixed order');
  assert.equal(v.orders.get('#1').excludedUnits, 4, 'pack 1 + random 1 + Mystery 2');
  assert.equal(v.orders.get('#4').plants, 1, 'the bundle with a Mystery plant counts 0; the single plant counts 1');
  assert.deepEqual(v.excluded, { units: 13, orders: 4 }, '#1: 4, #2: 1, #3: 7, #4: 1 (bundle)');
  // $1 per plant in every tier: savings only on eligible plants; the pack-only order gets $0.
  const s = mcgVolumeSavings(v, { '1': 1, '2–3': 1, '4–7': 1, '8+': 1 });
  assert.equal(s.total, 4);
  assert.deepEqual(s.tiers['1'], { orders: 1, plants: 1, savings: 1 });
  assert.deepEqual(s.tiers['2–3'], { orders: 1, plants: 3, savings: 3 });
  assert.equal(s.tiers['4–7'].orders + s.tiers['8+'].orders, 0, 'the 7-unit random/Mystery order is not in a tier');
  // Order revenue and net GP stay whole-order figures (the tier averages), unchanged.
  assert.equal(v.orders.get('#1').revenue, 70);
  // Without the pack table the model cannot tell packs apart; the page then projects nothing.
  assert.equal(hasPackTable(null), false); assert.equal(hasPackTable({}), false); assert.equal(hasPackTable(PACK), true);
});

test('MCG volume discount: the model uses the same eligibility as the engine\'s own discount', () => {
  // The engine gives a mixed order its tier discount on individual plants only; the model counts the same plants.
  const row = (name, sku, qty, price, i) => ({ Name: name, 'Created at': '2026-09-15 10:00:00 -0700', 'Lineitem quantity': String(qty),
    'Lineitem name': sku, 'Lineitem price': String(price), 'Lineitem sku': sku, 'Lineitem discount': '0', Vendor: 'Succulents Box',
    'Lineitem requires shipping': 'true', ...(i === 0 ? { Subtotal: '60', Shipping: '0', Taxes: '0', Total: '60', 'Discount Amount': '0', 'Refunded Amount': '0',
      'Financial Status': 'paid', 'Fulfillment Status': 'fulfilled', Source: 'web' } : {}) });
  const rows = [row('#9001', 'S2KY1048', 2, 10, 0), row('#9001', 'CXVY6173', 1, 10, 1), row('#9001', 'S2PK1001-10', 1, 20, 2), row('#9001', 'S3MY3003', 2, 5, 3)];
  const mcg = { S2KY1048: 4, CXVY6173: 4 };
  const lines = calculate(rows, new Map(), mcg, {}, {}, {}, {}, {}, null, {}, null, null, { mcgPackCosts: PACK });
  const byS = Object.fromEntries(lines.map(l => [l.sku, l]));
  assert.equal(byS['S2PK1001-10'].lineCogs, 18, 'pack: sheet cost, no discount');
  assert.equal(byS.S3MY3003.lineCogs, 4, 'Mystery: $2 × 2, no discount');
  const v = mcgVolumeOrders(lines, PACK);
  assert.equal(v.orders.get('#9001').plants, 3, 'the model counts the 3 plants the engine discounted (2–3 tier)');
  assert.ok(byS.S2KY1048.lineCogs < 8, 'the engine discounted the individual plants');
});

test('price projection: the shared resolver with the MCG pack sheet; an unknown cost stays unknown', () => {
  const t = { mcgCosts: { S2KY1048: 4.1 }, mcgPack: PACK };
  assert.deepEqual(projectionUnitCost([], 'S2PK1001-10', 'Pack', 'Succulents Box', t), { cost: 18, source: 'MCG pack sheet' });
  assert.equal(projectionUnitCost([], 'S3MY3003', 'Mystery', 'Succulents Box', t).cost, 2);
  assert.equal(projectionUnitCost([], 'CXNO4004', 'Sheet lists no cost', 'Succulents Box', t).cost, null, 'a blank/$0 sheet cost stays missing');
  assert.equal(projectionUnitCost([], 'ZZUNKNOWN1', 'New SKU', '', t).cost, null, 'no table has it: unknown, not $0');
  assert.equal(projectionUnitCost([], 'S2KY1048', 'Plant', 'Succulents Box', t).cost, 4.1);
  // Known-cost sales win; sales without a cost are ignored (they do not make the cost $0).
  assert.equal(projectionUnitCost([{ qty: 2, lineCogs: 9 }, { qty: 1, lineCogs: null }], 'S2KY1048', 'Plant', '', t).cost, 4.5);
  assert.equal(projectionUnitCost([{ qty: 3, lineCogs: null }], 'ZZUNKNOWN1', 'x', '', t).cost, null);
});

test('price projection totals: unknown costs are not $0; GP is known-cost and marked incomplete', () => {
  const rows = [{ id: 1, qty: 10, sellPrice: 10, costPerUnit: 4 }, { id: 2, qty: 5, sellPrice: 20, costPerUnit: null }];
  const base = [{ lineRevenue: 100, lineCogs: 60 }, { lineRevenue: 100, lineCogs: null }];      // a $100 line without a cost
  const T = projectionTotals(rows, base);
  assert.deepEqual(T.rows.find(r => r.id === 2), { id: 2, rev: 100, cogs: null, gp: null, gpPct: null });
  assert.deepEqual([T.proj.rev, T.proj.cogs, T.proj.gp, T.proj.gpPct, T.proj.incomplete, T.proj.revWithoutCost], [200, 40, 60, 60, true, 100]);
  assert.deepEqual([T.base.gp, T.base.incomplete, T.base.revWithoutCost], [40, true, 100], 'the $100 line without a cost adds no profit');
  assert.deepEqual([T.com.rev, T.com.gp, T.com.incomplete], [400, 100, true]);
  // Entering the cost completes it.
  const done = projectionTotals([{ id: 2, qty: 5, sellPrice: 20, costPerUnit: 7 }], []);
  assert.deepEqual([done.proj.cogs, done.proj.gp, done.proj.incomplete], [35, 65, false]);
});

test('without the MCG pack table, costs it would decide are unknown, never the older tier figure', () => {
  // The live case: a 30-pack resolved by the older rack rule at $60; the pack sheet says $30.
  const noPack = { mcgCosts: { S2KY1048: 4.1, S3MY3003: 4 }, mcgPack: null };
  assert.deepEqual(projectionUnitCost([], 'XAZZ3141-30', 'Succulent Pack (30 plants)', 'Succulents Box', noPack), { cost: null, source: PACK_TABLE_MISSING });
  assert.equal(projectionUnitCost([], 'XAZZ3141-30', 'Succulent Pack (30 plants)', 'Succulents Box', { ...noPack, mcgPack: { 'XAZZ3141-30': 30 } }).cost, 30, 'with the table: the sheet cost');
  // A single Mystery plant priced by the MCG Total sheet ($4; the pack sheet says $2): unknown without the table.
  assert.equal(projectionUnitCost([], 'S3MY3003', 'Mystery Succulent', 'Succulents Box', noPack).cost, null);
  // Random plants by the older $2 rules: unknown.
  assert.equal(projectionUnitCost([], 'JN1234', 'Random 2" succulent', 'Succulents Box', noPack).cost, null);
  // Individual plants keep their cost; known-cost sales still win (saved reports carry the engine's pinned costs).
  assert.equal(projectionUnitCost([], 'S2KY1048', 'Echeveria Lola', 'Succulents Box', noPack).cost, 4.1);
  assert.equal(projectionUnitCost([{ qty: 1, lineCogs: 30 }], 'XAZZ3141-30', 'Succulent Pack', 'Succulents Box', noPack).cost, 30);
  // Non-MCG products named "pack" are not affected.
  assert.equal(packDependent('LTG-100', 'Gift pack', 'Products export'), false);
  assert.equal(packDependent('S2KY1048+XAZZ3141-30', 'Bundle', 'Bundle (MCG Total sheet + MCG tier (Pack 30×$2))'), true);
});

test('CSV report without the MCG pack table: pack-dependent lines become missing costs, others unchanged', () => {
  const lines = [
    { sku: 'XAZZ3141-30', product: 'Succulent Pack (30 plants)', costSource: 'MCG tier (Pack 30×$2)', unitCost: 60, lineCogs: 60, lineGp: 10, lineGpPct: 14.3, lineNetGp: 8, lineNetGpPct: 11.4 },
    { sku: 'S2KY1048', product: 'Echeveria Lola', costSource: 'MCG Total sheet', unitCost: 4.1, lineCogs: 4.1, lineGp: 5, lineGpPct: 50, lineNetGp: 5, lineNetGpPct: 50 },
    { sku: 'GC100', product: 'Gift Card', costSource: 'Gift Card (no COGS)', unitCost: 0, lineCogs: 0, lineGp: 25, lineGpPct: 100, lineNetGp: 25, lineNetGpPct: 100 },
  ];
  assert.equal(markPackDependentUnknown(lines), 1);
  assert.deepEqual([lines[0].costSource, lines[0].lineCogs, lines[0].lineGp, lines[0].lineNetGp, lines[0].costMissingReason], ['COST MISSING', null, null, null, PACK_TABLE_MISSING]);
  assert.equal(lines[1].lineCogs, 4.1); assert.equal(lines[2].lineCogs, 0);
});
