/**
 * The scenario engine applies whatever scenarioRules the private rules supply.
 * Every rule set and line here is invented.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setPrivateRules, _clearPrivateRules } from '../shared/privateRules.js';
import {
  summarizeScenario, allocateOrderShipping, isPassThrough, isDiscountEligible, selectScenarioLines,
  laborAllocationShare, findMaximumDiscount, scenarioRules, ScenarioRulesError,
} from '../shared/scenario.js';

const BASE = JSON.parse(fs.readFileSync(new URL('./fixtures/private-rules.synthetic.json', import.meta.url), 'utf8'));
const RULES = {
  discountExcludedFlags: ['isPromo'],
  discountExcludedCostSources: ['fixed-price'],
  passThroughFlags: ['isFee'],
  allocation: { shipping: 'scenarioRevenue', advertising: 'scenarioRevenue', labor: 'currentRevenue',
                laborShare: 'lineRevenue', selectionShipping: 'baseRevenue' },
};
const use = (scenario) => setPrivateRules({ ...BASE, scenarioRules: scenario });
const withRules = (scenario, fn) => { use(scenario); try { return fn(); } finally { setPrivateRules(BASE); } };

const L = o => ({
  orderNum: o.order ?? '#1', date: '2026-03-10', source: 'web', sku: o.sku ?? 'A', product: o.sku ?? 'A',
  vendor: o.vendor ?? 'V1', vendorKey: o.vendor ?? 'V1', qty: o.qty ?? 1,
  unitPrice: (o.base ?? 10) / (o.qty ?? 1), baseMerchRevenue: o.base ?? 10, lineRevenue: o.revenue ?? o.base ?? 10,
  lineCogs: o.cogs ?? 4, missingCost: false, costSource: o.source ?? 'sheet',
  shipCollected: o.shipCollected ?? null, shipPaid: o.shipPaid ?? null,
  isPromo: !!o.promo, isFee: !!o.fee,
});
const book = () => [
  L({ order: '#1', sku: 'A', base: 20, qty: 2, cogs: 9, shipCollected: 5, shipPaid: 6 }),
  L({ order: '#1', sku: 'FEE', base: 1, cogs: 1, fee: true }),
  L({ order: '#1', sku: 'B', base: 10, cogs: 6 }),
  L({ order: '#2', sku: 'FEE', base: 1, cogs: 1, fee: true, shipCollected: 4, shipPaid: 4 }),
  L({ order: '#2', sku: 'B', base: 0, revenue: 0, cogs: 6 }),
  L({ order: '#3', sku: 'P', base: 8, cogs: 3, promo: true }),
  L({ order: '#4', sku: 'S', base: 12, cogs: 5, source: 'fixed-price' }),
];
const run = (a = {}) => summarizeScenario(book(), { sitewideDiscount: 0.2, adRate: 0.1, targetMargin: 0.1, monthlyLabor: 300,
  dateFrom: '2026-03-01', dateTo: '2026-03-31', ...a });

test('excluded flags and cost sources keep their revenue; other lines take the discount', () => withRules(RULES, () => {
  const r = run();
  const by = sku => r.lines.find(l => l.sku === sku);
  assert.deepEqual([by('P').discountEligible, by('P').scenarioRevenue], [false, 8]);
  assert.deepEqual([by('S').discountEligible, by('S').scenarioRevenue], [false, 12]);
  assert.deepEqual([by('A').effectiveDiscount, by('A').scenarioRevenue], [0.2, 16]);
}));

test('pass-through lines: no discount, advertising, labor or shipping, and outside vendor, SKU and cost results', () => withRules(RULES, () => {
  const r = run();
  for (const l of r.lines.filter(isPassThrough)) {
    assert.equal(l.discountEligible, false);
    assert.equal(l.scenarioRevenue, l.currentRevenue);
    assert.deepEqual([l.adExpense, l.laborExpense, l.allocShipCollected, l.allocShipExpense], [0, 0, 0, 0]);
    assert.deepEqual([l.maxLineCogs, l.maxUnitCost, l.viable], [null, null, null]);
  }
  assert.ok(!r.bySku.some(s => s.sku === 'FEE'));
  assert.deepEqual(r.passThrough, { collected: 2, remitted: 2, net: 0, lines: 2 });
  assert.equal(r.scenario.adExpense, Math.round(r.scenario.scenarioRevenue * 0.1 * 100) / 100);
  assert.ok(r.reconciliation.ok, JSON.stringify(r.reconciliation.checks.filter(c => !c.ok)));
  // Order #2's other line has zero revenue: it still carries the order's shipping.
  const b2 = r.lines.find(l => l.orderNum === '#2' && l.sku === 'B');
  assert.deepEqual([b2.allocShipCollected, b2.allocShipExpense], [4, 4]);
}));

test('the flags a rule set names decide pass-through, not any fixed field', () => {
  const swapped = { ...RULES, passThroughFlags: ['isPromo'], discountExcludedFlags: [] };
  withRules(swapped, () => {
    assert.equal(isPassThrough(L({ promo: true })), true);
    assert.equal(isPassThrough(L({ fee: true })), false);
    assert.equal(isDiscountEligible(L({ fee: true })), true);
  });
});

test('allocation weights are chosen by the rules', () => {
  const lines = [
    { orderNum: '#9', scenarioRevenue: 30, currentRevenue: 30, qty: 1, shipCollected: 8, shipPaid: 6 },
    { orderNum: '#9', scenarioRevenue: 10, currentRevenue: 10, qty: 3, shipCollected: null, shipPaid: null },
  ];
  const ship = weight => withRules({ ...RULES, allocation: { ...RULES.allocation, shipping: weight } },
    () => allocateOrderShipping(lines).map(l => [l.allocShipCollected, l.allocShipExpense]));
  assert.deepEqual(ship('scenarioRevenue'), [[6, 4.5], [2, 1.5]]);
  assert.deepEqual(ship('units'), [[2, 1.5], [6, 4.5]]);
  assert.deepEqual(ship('equal'), [[4, 3], [4, 3]]);

  const labor = weight => withRules({ ...RULES, allocation: { ...RULES.allocation, labor: weight } },
    () => summarizeScenario([L({ order: '#1', sku: 'A', base: 30 }), L({ order: '#2', sku: 'B', base: 10, qty: 3 })],
      { monthlyLabor: 40, dateFrom: '2026-03-01', dateTo: '2026-03-31' }).lines.map(l => l.laborExpense));
  assert.deepEqual(labor('currentRevenue'), [30, 10]);
  assert.deepEqual(labor('units'), [10, 30]);
});

test('labor share and selection shipping follow the rules', () => withRules(RULES, () => {
  const lines = [L({ order: '#1', vendor: 'V1', base: 30, shipCollected: 8, shipPaid: 8 }), L({ order: '#1', vendor: 'V2', base: 10 })];
  assert.equal(laborAllocationShare(lines, { vendorFilter: 'V2' }).share, 0.25);
  assert.equal(selectScenarioLines(lines, { vendorFilter: 'V2' })[0].shipCollected, 2);
  use({ ...RULES, allocation: { ...RULES.allocation, laborShare: 'equal', selectionShipping: 'equal' } });
  assert.equal(laborAllocationShare(lines, { vendorFilter: 'V2' }).share, 0.5);
  assert.equal(selectScenarioLines(lines, { vendorFilter: 'V2' })[0].shipCollected, 4);
}));

test('a pass-through-only selection has no revenue to solve', () => withRules(RULES, () => {
  assert.equal(findMaximumDiscount([L({ fee: true })], { targetMargin: 0.1 }).status, 'no_revenue');
}));

test('missing or invalid rules stop the calculation with a clear error', () => {
  const bad = [
    [undefined, 'missing'],
    [{ ...RULES, passThroughFlags: 'isFee' }, 'passThroughFlags'],
    [{ ...RULES, discountExcludedFlags: [''] }, 'discountExcludedFlags'],
    [{ ...RULES, discountExcludedCostSources: null }, 'discountExcludedCostSources'],
    [{ ...RULES, allocation: undefined }, 'allocation'],
    [{ ...RULES, allocation: { ...RULES.allocation, labor: 'headcount' } }, 'allocation.labor'],
    [{ ...RULES, allocation: { ...RULES.allocation, shipping: undefined } }, 'allocation.shipping'],
    [{ ...RULES, allocation: { ...RULES.allocation, laborShare: 'scenarioRevenue' } }, 'allocation.laborShare'],
  ];
  for (const [rules, detail] of bad) {
    withRules(rules, () => {
      assert.throws(() => run(), e => e instanceof ScenarioRulesError && e.message === `scenario_rules_invalid:${detail}`);
      assert.throws(() => isPassThrough(L({})), ScenarioRulesError);
    });
  }
  _clearPrivateRules();
  try {
    assert.throws(() => scenarioRules(), { message: 'scenario_rules_invalid:missing' });
    assert.throws(() => summarizeScenario([L({})], {}), ScenarioRulesError);
  } finally { setPrivateRules(BASE); }
});
