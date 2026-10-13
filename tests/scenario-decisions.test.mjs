/**
 * Discount & operating margin decision answers:
 *   1. maximum general discount that keeps the target operating margin;
 *   2. product-cost reduction needed for a proposed discount;
 *   3. the discount comparison table.
 * Expected values are derived by hand (closed form) or by brute force over every supported increment through
 * summarizeScenario, never by re-implementing the solver.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { calculate } from '../js/calculator.js';
import {
  summarizeScenario, findMaximumDiscount, calculateCostReduction, compareDiscountLevels,
  selectScenarioLines, excludedCostCoverage, meetsTargetMargin, generalDiscountScope,
  laborAllocationShare, prepareDecision,
  DISCOUNT_STEP, AVG_DAYS_PER_MONTH,
} from '../js/scenario.js';
import { row, VENDOR_COSTS } from './fixtures.mjs';

const near = (a, b, tol = 0.011, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} expected ≈${b}, got ${a}`);

/** A synthetic engine line (the fields calculate() produces that the scenario engine reads). */
function L(o) {
  const base = o.base ?? 100;
  return {
    orderNum: o.order ?? '#1', date: o.date ?? '2026-09-10', source: o.source ?? 'Online Store',
    sku: o.sku ?? 'SKU-A', product: o.product ?? o.sku ?? 'Product A',
    vendor: o.vendor ?? 'Vendor One', vendorKey: o.vendor ?? 'Vendor One',
    qty: o.qty ?? 1, unitPrice: base / (o.qty ?? 1), baseMerchRevenue: base,
    lineRevenue: o.revenue ?? base,
    lineCogs: o.missing ? null : (o.cogs ?? 40), missingCost: !!o.missing,
    shipCollected: o.shipCollected ?? null, shipPaid: o.shipPaid ?? null,
    isGiftCard: !!o.giftCard, isRoute: !!o.route, isInfluencerSample: !!o.sample,
    costSource: o.giftCard ? 'Gift Card (no COGS)' : 'test',
  };
}
const NO_LABOR = { monthlyLabor: 0, adRate: 0.10, vendorDiscounts: {} };

/** Brute force: largest supported increment that meets the target, through the engine. */
function bruteMax(lines, a) {
  let best = null;
  for (let k = 0; k <= Math.round(1 / DISCOUNT_STEP); k++) {
    const s = summarizeScenario(lines, { ...a, sitewideDiscount: k * DISCOUNT_STEP });
    if (meetsTargetMargin(s, a.targetMargin)) best = k * DISCOUNT_STEP;
  }
  return best;
}

// One order: $100 product, $40 cost, $10 shipping collected and paid, advertising 10%.
// Operating profit = 0.9R − 40, total revenue = R + 10 (R = 100 × (1 − d)).
const one = () => [L({ shipCollected: 10, shipPaid: 10 })];

test('max discount: solves the target exactly when it falls on an increment (closed form 40%)', () => {
  // 0.9R − 40 ≥ 0.2(R + 10) → R ≥ 60 → d ≤ 40%.
  const r = findMaximumDiscount(one(), { ...NO_LABOR, targetMargin: 0.20 });
  assert.equal(r.status, 'ok');
  assert.equal(r.discount, 0.40);
  assert.equal(r.summary.scenario.operatingProfit, 14);
  assert.equal(r.summary.scenario.operatingMargin, 20);
  assert.equal(r.summary.scenario.adExpense, 6, 'advertising moves with the discounted revenue (10% of $60)');
  assert.equal(r.verification.ok, true);
  assert.equal(r.verification.nextFails, true);
  assert.equal(r.next.discount, 0.405);
  assert.ok(r.next.operatingMargin < 20);
  assert.equal(r.provisional, false);
});

test('max discount: rounds DOWN to the supported increment that still meets the target', () => {
  // 0.9R − 40 ≥ 0.19(R + 10) → R ≥ 59.0141 → d ≤ 40.99% → 40.5% (41% gives R = 59 and misses).
  const a = { ...NO_LABOR, targetMargin: 0.19 };
  const r = findMaximumDiscount(one(), a);
  assert.equal(r.discount, 0.405);
  assert.ok(meetsTargetMargin(r.summary, 0.19));
  assert.ok(!meetsTargetMargin(summarizeScenario(one(), { ...a, sitewideDiscount: 0.41 }), 0.19));
  assert.equal(r.discount, bruteMax(one(), a));
});

test('max discount: labor and advertising are charged, and labor is prorated by the period', () => {
  // Sep 1–15 (15 days): labor = 304.375 × 15 / 30.4375 = $150. Lines at $1,000 product, $300 cost, no shipping.
  const lines = [L({ base: 1000, cogs: 300, date: '2026-09-05' })];
  const a = { adRate: 0.15, monthlyLabor: 304.375, dateFrom: '2026-09-01', dateTo: '2026-09-15', targetMargin: 0.20, vendorDiscounts: {} };
  const r = findMaximumDiscount(lines, a);
  near(r.summary.labor.allocated, 304.375 * 15 / AVG_DAYS_PER_MONTH);
  // 0.85R − 300 − 150 ≥ 0.2R → R ≥ 692.31 → d ≤ 30.77% → 30.5%.
  assert.equal(r.discount, 0.305);
  assert.equal(r.discount, bruteMax(lines, a));
  assert.equal(r.verification.ok, true);
});

test('max discount: Discount by vendor stays fixed; only the general discount on the rest is solved', () => {
  const lines = [
    L({ order: '#1', vendor: 'Calathea Collective', sku: 'CC-1', base: 100, cogs: 40 }),
    L({ order: '#2', vendor: 'Surfside Arrangement', sku: 'SUR-1', base: 200, cogs: 90 }),
  ];
  const a = { ...NO_LABOR, targetMargin: 0.15, vendorDiscounts: { 'Calathea Collective': 0.17 } };
  const r = findMaximumDiscount(lines, a);
  assert.equal(r.status, 'ok');
  const cc = r.summary.lines.find(l => l.vendorKey === 'Calathea Collective');
  const sur = r.summary.lines.find(l => l.vendorKey === 'Surfside Arrangement');
  assert.equal(cc.effectiveDiscount, 0.17, 'the vendor rate is not replaced by the solved general discount');
  assert.equal(sur.effectiveDiscount, r.discount);
  // Closed form: R = 83 + 200(1 − d); 0.9R − 130 ≥ 0.15R → R ≥ 173.33 → d ≤ 54.83% → 54.5%.
  assert.equal(r.discount, 0.545);
  assert.equal(r.discount, bruteMax(lines, a));
  assert.deepEqual(r.generalScope, { lines: 1, baseRevenue: 200 });
});

test('max discount: every eligible product overridden → no general scope, no number returned', () => {
  const lines = [L({ vendor: 'Calathea Collective' })];
  const r = findMaximumDiscount(lines, { ...NO_LABOR, targetMargin: 0.1, vendorDiscounts: { 'Calathea Collective': 0.2 } });
  assert.equal(r.status, 'no_general_scope');
  assert.equal(r.discount, null);
});

test('max discount: discount-excluded lines (gift card, influencer sample, Route) keep their revenue', () => {
  const lines = [
    L({ order: '#1', base: 100, cogs: 40 }),
    L({ order: '#2', sku: 'GIFT', base: 50, cogs: 0, giftCard: true }),
    L({ order: '#3', sku: 'SAMPLE', base: 30, revenue: 0, cogs: 12, sample: true }),
    L({ order: '#4', sku: 'ROUTE', base: 2, revenue: 2, cogs: 0, route: true }),
  ];
  const a = { ...NO_LABOR, targetMargin: 0.20 };
  const r = findMaximumDiscount(lines, a);
  const by = sku => r.summary.lines.find(l => l.sku === sku);
  assert.equal(by('GIFT').scenarioRevenue, 50);
  assert.equal(by('SAMPLE').scenarioRevenue, 0);
  assert.equal(by('ROUTE').effectiveDiscount, 0);
  // R = 100(1 − d) + 50 (+ $0 sample); COGS 52 → 0.9R − 52 ≥ 0.2R → R ≥ 74.29 → d ≤ 75.71% → 75.5%.
  // Route is a pass-through outside product revenue.
  assert.equal(r.discount, 0.755);
  assert.equal(r.discount, bruteMax(lines, a));
  assert.equal(r.generalScope.lines, 1);
});

test('max discount: a target that cannot be met at 0% general discount is reported, never as 0% or negative', () => {
  const r = findMaximumDiscount(one(), { ...NO_LABOR, targetMargin: 0.60 });
  assert.equal(r.status, 'target_not_met_at_zero');
  assert.equal(r.discount, null);
  // At 0%: OP = 90 − 40 = 50 on 110 → 45.5%.
  assert.equal(r.marginAtZero, 45.5);
});

test('max discount: the upper bound is reported when even 100% keeps the target', () => {
  const lines = [L({ order: '#1', base: 100, cogs: 0 }), L({ order: '#2', sku: 'GIFT', base: 100, cogs: 0, giftCard: true })];
  const r = findMaximumDiscount(lines, { ...NO_LABOR, targetMargin: 0.2 });
  assert.equal(r.status, 'upper_bound');
  assert.equal(r.discount, 1);
  assert.equal(r.verification.atUpperBound, true);
  assert.equal(r.verification.ok, true);
});

test('max discount: real calculate() lines agree with brute force through the engine', () => {
  const rows = [
    row({ Name: '#912351', 'Lineitem sku': 'CC-WC-PLANT-DAD', Vendor: 'Calathea Collective', 'Lineitem name': 'Watering Can',
          'Lineitem price': '45.00', 'Lineitem quantity': '2', Shipping: '9.00', Subtotal: '90.00', Total: '99.00' }),
    row({ Name: '#912352', 'Lineitem sku': 'SUR-HEART-SMALL', Vendor: 'Surfside Arrangement', 'Lineitem name': 'Small Heart',
          'Lineitem price': '80.00', 'Lineitem quantity': '1', Shipping: '12.00', Subtotal: '80.00', Total: '92.00' }),
    row({ Name: '#912353', 'Lineitem sku': 'PL_FLF_4IN1', Vendor: 'Lively Root', 'Lineitem name': 'Fiddle Leaf Fig Tree',
          'Lineitem price': '67.08', 'Lineitem quantity': '1', Shipping: '15.00', Subtotal: '67.08', Total: '82.08' }),
  ];
  const ship = new Map([['912351', 7.5], ['912352', 11.0], ['912353', 14.0]]);
  const lines = calculate(rows, ship, {}, {}, {}, {}, {}, {}, null, {}, VENDOR_COSTS, null, {});
  const a = { adRate: 0.15, monthlyLabor: 40, targetMargin: 0.12, vendorDiscounts: { 'Calathea Collective': 0.17 } };
  const r = findMaximumDiscount(lines, a);
  assert.equal(r.status, 'ok');
  assert.equal(r.discount, bruteMax(lines, a));
  assert.equal(r.verification.ok, true);
  assert.equal(r.summary.reconciliation.ok, true);
});

test('cost reduction: maximum affordable COGS, dollars and percentage (rounded up), verified by substitution', () => {
  // d = 40%, target 25%: R = 60, TR = 70, ad 6 → OP = 54 − COGS ≥ 17.5 → max COGS 36.50; 40 → 36.50 = $3.50 (8.75%).
  const r = calculateCostReduction(one(), { ...NO_LABOR, sitewideDiscount: 0.40, targetMargin: 0.25 });
  assert.equal(r.status, 'reduction_needed');
  assert.equal(r.currentCogs, 40);
  assert.equal(r.maxCogs, 36.5);
  assert.equal(r.reductionDollars, 3.5);
  assert.equal(r.reductionPct, 8.8, 'shown rounded up so the stated cut is enough');
  near(r.reductionPctExact, 8.75, 1e-9);
  assert.equal(r.marginWithoutReduction, 20);
  assert.equal(r.verification.ok, true);
  near(r.verification.margin, 0.25, 1e-6);
});

test('cost reduction: verification holds across many lines and the vendor-fixed discount', () => {
  const lines = [];
  for (let i = 0; i < 60; i++) {
    lines.push(L({ order: `#${i}`, sku: `S${i % 7}`, vendor: i % 3 ? 'Vendor One' : 'Calathea Collective',
                   base: 20 + (i * 7.31) % 50, cogs: 9 + (i * 3.17) % 20, shipCollected: i % 2 ? 6.5 : 0, shipPaid: 5.75 }));
  }
  const a = { adRate: 0.15, monthlyLabor: 500, dateFrom: '2026-09-01', dateTo: '2026-09-30', targetMargin: 0.15,
              vendorDiscounts: { 'Calathea Collective': 0.17 }, sitewideDiscount: 0.20 };
  const r = calculateCostReduction(lines, a);
  assert.equal(r.status, 'reduction_needed');
  assert.equal(r.verification.ok, true, JSON.stringify(r.verification));
  assert.ok(Math.abs(r.verification.margin - 0.15) < 0.0005);
});

test('cost reduction: "none needed" when current costs already meet the target', () => {
  const r = calculateCostReduction(one(), { ...NO_LABOR, sitewideDiscount: 0.10, targetMargin: 0.20 });
  assert.equal(r.status, 'none_needed');
  assert.equal(r.reductionDollars, null);
  assert.equal(r.marginWithoutReduction, 41);
});

test('cost reduction: "cost alone insufficient" when even $0 product cost misses the target', () => {
  // d = 90%: R = 10, TR = 20, ad 1, shipping nets 0 → at $0 cost OP = 9 → 45% < 60%.
  const r = calculateCostReduction(one(), { ...NO_LABOR, sitewideDiscount: 0.90, targetMargin: 0.60 });
  assert.equal(r.status, 'cost_alone_insufficient');
  assert.ok(r.maxCogs < 0);
  assert.equal(r.reductionDollars, null);
  assert.equal(r.marginAtZeroCogs, 45);
  assert.equal(r.verification.ok, true);
});

test('missing costs: included → every answer is provisional; excluded → costed products only, with what was left out', () => {
  const all = [
    L({ order: '#1', sku: 'A', base: 100, cogs: 40, shipCollected: 10, shipPaid: 10 }),
    L({ order: '#2', sku: 'B', base: 60, qty: 3, missing: true }),
  ];
  const inc = { ...NO_LABOR, targetMargin: 0.2 };
  const max = findMaximumDiscount(all, inc);
  const cost = calculateCostReduction(all, { ...inc, sitewideDiscount: 0.3 });
  const rows = compareDiscountLevels(all, inc);
  assert.equal(max.provisional, true);
  assert.equal(cost.provisional, true);
  assert.ok(rows.every(x => x.provisional));
  // The missing cost is never filled in as a number: the line keeps cogs null and is counted as missing.
  const miss = max.summary.lines.find(l => l.sku === 'B');
  assert.equal(miss.cogs, null); assert.equal(miss.missingCost, true);
  assert.equal(max.summary.scenario.missingCostLines, 1);

  const ex = { ...inc, excludeMissing: true };
  const costed = selectScenarioLines(all, ex);
  assert.deepEqual(costed.map(l => l.sku), ['A']);
  const exMax = findMaximumDiscount(costed, ex);
  assert.equal(exMax.provisional, false);
  assert.equal(exMax.discount, 0.40);            // the single costed order alone (closed form above)
  assert.ok(compareDiscountLevels(costed, ex).every(x => !x.provisional));
  assert.deepEqual(excludedCostCoverage(selectScenarioLines(all, inc)),
    { skus: 1, totalSkus: 2, units: 3, totalUnits: 4, lines: 1, revenue: 60, totalRevenue: 160, revenuePct: 37.5 });
});

test('filtered scopes: vendor and channel filters select the lines and carry their revenue share of labor', () => {
  const all = [
    L({ order: '#1', vendor: 'Vendor One', sku: 'A', base: 100, cogs: 40, source: 'Online Store' }),
    L({ order: '#2', vendor: 'Vendor Two', sku: 'B', base: 300, cogs: 100, source: 'Online Store' }),
    L({ order: '#3', vendor: 'Vendor One', sku: 'C', base: 50, cogs: 10, source: 'Amazon' }),
  ];
  const a = { adRate: 0.1, monthlyLabor: 30, dateFrom: '2026-09-01', dateTo: '2026-09-30', targetMargin: 0.1, vendorDiscounts: {} };
  assert.deepEqual(selectScenarioLines(all, { ...a, channelFilter: 'Amazon' }).map(l => l.sku), ['C']);
  const d = prepareDecision(all, { ...a, vendorFilter: 'Vendor One' });
  assert.deepEqual(d.lines.map(l => l.sku), ['A', 'C']);
  near(d.labor.share, 150 / 450, 1e-12);
  const r = findMaximumDiscount(d.lines, d.assumptions);
  assert.equal(r.summary.labor.periodLabor, 30, 'whole-month labor for the period');
  assert.equal(r.summary.scenario.labor, 10, 'Vendor One: $150 of $450 historical net product revenue → one third');
  // R = 150(1 − d); 0.9R − 50 − 10 ≥ 0.1R → R ≥ 75 → d ≤ 50%.
  assert.equal(r.discount, 0.5);
  assert.equal(r.discount, bruteMax(d.lines, d.assumptions));
});

test('comparison table: same scope and assumptions per row, matching the single-discount answer', () => {
  const lines = [
    L({ order: '#1', vendor: 'Calathea Collective', sku: 'CC-1', base: 100, cogs: 40 }),
    L({ order: '#2', vendor: 'Vendor One', sku: 'V-1', base: 200, cogs: 120, shipCollected: 10, shipPaid: 14 }),
  ];
  const a = { adRate: 0.15, monthlyLabor: 0, targetMargin: 0.18, vendorDiscounts: { 'Calathea Collective': 0.17 } };
  const rows = compareDiscountLevels(lines, a, [0.05, 0.10, 0.15, 0.20, 0.125, 0.10]);
  assert.deepEqual(rows.map(r => r.discount), [0.05, 0.10, 0.125, 0.15, 0.20], 'custom level added, duplicates dropped, sorted');
  for (const row of rows) {
    const single = calculateCostReduction(lines, { ...a, sitewideDiscount: row.discount });
    assert.equal(row.status, single.status);
    assert.equal(row.operatingMargin, single.marginWithoutReduction);
    assert.equal(row.reductionDollars, single.reductionDollars);
    assert.equal(row.reductionPct, single.reductionPct);
    // The vendor rate is identical on every row.
    assert.equal(single.summary.lines.find(l => l.vendorKey === 'Calathea Collective').effectiveDiscount, 0.17);
  }
  assert.equal(rows[0].status, 'none_needed');
  assert.equal(rows.at(-1).status, 'reduction_needed');
  const impossible = compareDiscountLevels(lines, { ...a, targetMargin: 0.9 }, [0.2]);
  assert.equal(impossible[0].status, 'cost_alone_insufficient');
});

test('the maximum discount and the cost-reduction answer agree at the boundary', () => {
  const a = { ...NO_LABOR, targetMargin: 0.19 };
  const max = findMaximumDiscount(one(), a);
  assert.equal(calculateCostReduction(one(), { ...a, sitewideDiscount: max.discount }).status, 'none_needed');
  const beyond = calculateCostReduction(one(), { ...a, sitewideDiscount: max.discount + DISCOUNT_STEP });
  assert.equal(beyond.status, 'reduction_needed');
  assert.ok(beyond.reductionDollars > 0);
});

test('generalDiscountScope ignores ineligible and overridden lines', () => {
  const lines = [L({ order: '#1' }), L({ order: '#2', giftCard: true }), L({ order: '#3', vendor: 'Calathea Collective' })];
  assert.deepEqual(generalDiscountScope(lines, { 'Calathea Collective': 0.1 }), { lines: 1, baseRevenue: 100 });
});

// ── Review follow-ups ─────────────────────────────────────────────────────────

test('excluding a missing-cost line keeps a revenue share of its order’s shipping, whatever the line order', () => {
  // Order #1: missing-cost M ($50) and costed A ($100, cost 40); order shipping collected $30, expense $45.
  const M = (first) => L({ order: '#1', sku: 'M', base: 50, missing: true, ...(first ? { shipCollected: 30, shipPaid: 45 } : {}) });
  const A = (first) => L({ order: '#1', sku: 'A', base: 100, cogs: 40, ...(first ? { shipCollected: 30, shipPaid: 45 } : {}) });
  const a = { ...NO_LABOR, targetMargin: 0.2, excludeMissing: true };
  const r1 = selectScenarioLines([M(true), A(false)], a), r2_ = selectScenarioLines([A(true), M(false)], a);
  for (const r of [r1, r2_]) {
    assert.deepEqual(r.map(l => l.sku), ['A']);
    assert.equal(r[0].shipCollected, 20, 'two thirds of $30 (A is $100 of the order’s $150)');
    assert.equal(r[0].shipPaid, 30, 'two thirds of $45');
  }
  assert.equal(findMaximumDiscount(r1, a).discount, findMaximumDiscount(r2_, a).discount);
  // A whole order kept is untouched; a whole order excluded is dropped with its shipping.
  const whole = selectScenarioLines([L({ order: '#9', sku: 'Z', missing: true, shipCollected: 5, shipPaid: 6 })], a);
  assert.equal(whole.length, 0);
});

test('a vendor filter gives the vendor its revenue share of a mixed order’s shipping', () => {
  const lines = [
    L({ order: '#1', vendor: 'Vendor Two', sku: 'B', base: 300, cogs: 100, shipCollected: 20, shipPaid: 16 }),
    L({ order: '#1', vendor: 'Vendor One', sku: 'A', base: 100, cogs: 40 }),
  ];
  const v1 = selectScenarioLines(lines, { vendorFilter: 'Vendor One' });
  assert.equal(v1[0].shipCollected, 5); assert.equal(v1[0].shipPaid, 4);
  const v1rev = selectScenarioLines([...lines].reverse(), { vendorFilter: 'Vendor One' });
  assert.equal(v1rev[0].shipCollected, 5); assert.equal(v1rev[0].shipPaid, 4);
  // Unfiltered selections are returned as they are.
  assert.deepEqual(selectScenarioLines(lines, {}), lines);
});

test('cost reduction near the target never reads "0.0% ($0.00)": at least one cent, and status agrees with the exact test', () => {
  // Reviewer case: base $1,000, cost $750.03, shipping collected $0.03, ad 10%, target 15%, 0% discount.
  const lines = [L({ base: 1000, cogs: 750.03, shipCollected: 0.03, shipPaid: 0 })];
  const a = { ...NO_LABOR, sitewideDiscount: 0, targetMargin: 0.15 };
  const r = calculateCostReduction(lines, a);
  assert.equal(meetsTargetMargin(r.summary, 0.15), false);
  assert.equal(r.status, 'reduction_needed');
  assert.ok(r.reductionDollars >= 0.01);
  assert.ok(r.reductionPct >= 0.1);
  assert.equal(r.verification.ok, true);
  // And the maximum-discount mode agrees that 0% already misses.
  assert.equal(findMaximumDiscount(lines, a).status, 'target_not_met_at_zero');
});

test('an undefined Discount by vendor rate means "no vendor rate", as in the engine', () => {
  const lines = [L({ vendor: 'Vendor One' })];
  assert.deepEqual(generalDiscountScope(lines, { 'Vendor One': undefined }), { lines: 1, baseRevenue: 100 });
  assert.equal(findMaximumDiscount(lines, { ...NO_LABOR, targetMargin: 0.1, vendorDiscounts: { 'Vendor One': undefined } }).status, 'ok');
});

test('cost mode reports when no product takes the general discount', () => {
  const r = calculateCostReduction([L({ vendor: 'Calathea Collective' })],
    { ...NO_LABOR, sitewideDiscount: 0.3, targetMargin: 0.1, vendorDiscounts: { 'Calathea Collective': 0.2 } });
  assert.equal(r.generalScope.lines, 0);
});

test('no revenue (a Route-only selection) is reported, not solved', () => {
  const lines = [L({ sku: 'ROUTE', base: 2, revenue: 2, cogs: 0, route: true })];
  assert.equal(findMaximumDiscount(lines, { ...NO_LABOR, targetMargin: 0.1 }).status, 'no_revenue');
  assert.equal(calculateCostReduction(lines, { ...NO_LABOR, targetMargin: 0.1 }).status, 'no_revenue');
});

test('a negative target margin is solved like any other', () => {
  // 0.9R − 40 ≥ −0.1(R + 10) → R ≥ 39 → d ≤ 61%.
  const a = { ...NO_LABOR, targetMargin: -0.10 };
  const r = findMaximumDiscount(one(), a);
  assert.equal(r.discount, 0.61);
  assert.equal(r.discount, bruteMax(one(), a));
});

test('comparison rows match closed-form values', () => {
  // one(): R = 100(1 − d), TR = R + 10, ad 0.1R, OP = 0.9R − 40. Target 25%: max COGS = 0.65R − 2.5.
  const rows = compareDiscountLevels(one(), { ...NO_LABOR, targetMargin: 0.25 }, [0.05, 0.40, 0.90]);
  assert.equal(rows[0].status, 'none_needed');                 // R = 95: margin 45.5/105 = 43.3%
  assert.equal(rows[0].operatingMargin, 43.3);
  assert.equal(rows[1].status, 'reduction_needed');            // R = 60: max COGS 36.50 → $3.50, 8.75% → 8.8%
  assert.equal(rows[1].operatingMargin, 20);
  assert.equal(rows[1].reductionDollars, 3.5);
  assert.equal(rows[1].reductionPct, 8.8);
  assert.equal(rows[2].status, 'reduction_needed');            // R = 10: max COGS 0.65·10 − 2.5 = 4.00 → $36 (90%)
  assert.equal(rows[2].reductionDollars, 36);
  assert.equal(rows[2].reductionPct, 90);
  // Target 60% at 90%: max COGS = 0.3·10 − 6 = −3 → product costs alone cannot reach it.
  assert.equal(compareDiscountLevels(one(), { ...NO_LABOR, targetMargin: 0.6 }, [0.9])[0].status, 'cost_alone_insufficient');
});

// ── Labor allocation for filtered decisions ──────────────────────────────────

/** A month of orders across three vendors and two channels, with historical discounts, a refund and a missing cost. */
function month() {
  const out = [];
  const vendors = ['Vendor One', 'Calathea Collective', 'Mountain Crest Gardens'];
  for (let i = 0; i < 90; i++) {
    const vendor = vendors[i % 3], base = 18 + (i * 13.7) % 70;
    out.push(L({ order: `#${1000 + Math.floor(i / 2)}`, vendor, sku: `${vendor.slice(0, 3)}-${i % 11}`, base,
                 revenue: i % 7 === 0 ? r2c(base * 0.85) : (i === 40 ? 0.01 : base), cogs: r2c(base * 0.42),
                 missing: i % 17 === 5, source: i % 4 === 0 ? 'Amazon' : 'Online Store',
                 date: `2026-09-${String(1 + (i % 30)).padStart(2, '0')}`,
                 shipCollected: i % 2 === 0 ? 7.5 : null, shipPaid: i % 2 === 0 ? 9.25 : null }));
  }
  out.push(L({ order: '#1100', sku: 'ROUTE', base: 3, revenue: 3, cogs: 0, route: true }));
  return out;
}
function r2c(n) { return Math.round(n * 100) / 100; }
const MONTH_A = { adRate: 0.15, monthlyLabor: 9500, dateFrom: '2026-09-01', dateTo: '2026-09-30', targetMargin: 0.05, vendorDiscounts: {}, sitewideDiscount: 0.1 };
const laborOf = (all, a) => { const d = prepareDecision(all, a); return calculateCostReduction(d.lines, d.assumptions, { verify: false }).summary.scenario.labor; };

test('labor: vendor selections reconcile to the period’s total labor', () => {
  const all = month();
  const vendors = [...new Set(all.filter(l => !l.isRoute).map(l => l.vendorKey))];
  const parts = vendors.map(v => laborOf(all, { ...MONTH_A, vendorFilter: v }));
  const total = parts.reduce((s, x) => s + x, 0);
  assert.equal(laborOf(all, MONTH_A), 9500, 'all vendors and channels carry the whole month');
  assert.ok(Math.abs(total - 9500) <= 0.01 * vendors.length, `vendor shares sum to ${total}`);
  const shares = vendors.map(v => laborAllocationShare(all, { ...MONTH_A, vendorFilter: v }).share);
  near(shares.reduce((s, x) => s + x, 0), 1, 1e-12);
  // The share is historical net product revenue (refunds and historical discounts included), not list price.
  const rev = v => all.filter(l => !l.isRoute && l.vendorKey === v).reduce((s, l) => s + l.lineRevenue, 0);
  const totalRev = all.filter(l => !l.isRoute).reduce((s, l) => s + l.lineRevenue, 0);
  vendors.forEach((v, i) => near(shares[i], rev(v) / totalRev, 1e-12));
});

test('labor: channel and vendor × channel selections partition the same total', () => {
  const all = month();
  const chans = ['Amazon', 'Online Store'];
  const byChan = chans.map(c => laborOf(all, { ...MONTH_A, channelFilter: c }));
  assert.ok(Math.abs(byChan[0] + byChan[1] - 9500) <= 0.02);
  const vendors = ['Vendor One', 'Calathea Collective', 'Mountain Crest Gardens'];
  let cells = 0;
  for (const v of vendors) for (const c of chans) cells += laborOf(all, { ...MONTH_A, vendorFilter: v, channelFilter: c });
  assert.ok(Math.abs(cells - 9500) <= 0.06, `vendor × channel cells sum to ${cells}`);
});

test('labor: a selection’s labor is frozen across discount levels and both modes', () => {
  const all = month();
  const a = { ...MONTH_A, vendorFilter: 'Calathea Collective', vendorDiscounts: { 'Mountain Crest Gardens': 0.2 } };
  const d = prepareDecision(all, a);
  const expected = r2c(9500 * d.labor.share);
  for (const disc of [0, 0.05, 0.1, 0.3, 0.6]) {
    const r = calculateCostReduction(d.lines, { ...d.assumptions, sitewideDiscount: disc });
    assert.equal(r.summary.scenario.labor, expected, `labor at ${disc}`);
  }
  const rows = compareDiscountLevels(d.lines, d.assumptions, [0.05, 0.1, 0.15, 0.2, 0.35]);
  assert.ok(rows.every(x => x.labor === expected));
  const m = findMaximumDiscount(d.lines, d.assumptions);
  if (m.summary) assert.equal(m.summary.scenario.labor, expected);
  // Line-level labor (vendor and SKU rows) does not move with the discount either.
  const all0 = calculateCostReduction(all, { ...MONTH_A, sitewideDiscount: 0 }, { verify: false }).summary;
  const all3 = calculateCostReduction(all, { ...MONTH_A, sitewideDiscount: 0.3, vendorDiscounts: { 'Vendor One': 0.05 } }, { verify: false }).summary;
  for (const v of all0.byVendor) assert.equal(all3.byVendor.find(x => x.vendor === v.vendor).labor, v.labor);
});

test('labor: vendor rows of the full view agree with the vendor-filtered selections', () => {
  const all = month();
  const full = calculateCostReduction(selectScenarioLines(all, MONTH_A), MONTH_A, { verify: false }).summary;
  for (const v of full.byVendor) near(v.labor, laborOf(all, { ...MONTH_A, vendorFilter: v.vendor }), 0.011, v.vendor);
});

test('labor: excluding products without a cost keeps only the included products’ share', () => {
  const all = month();
  const totalRev = all.filter(l => !l.isRoute).reduce((s, l) => s + l.lineRevenue, 0);
  const missingRev = all.filter(l => !l.isRoute && l.missingCost).reduce((s, l) => s + l.lineRevenue, 0);
  assert.ok(missingRev > 0);
  const ex = prepareDecision(all, { ...MONTH_A, excludeMissing: true });
  near(ex.labor.share, (totalRev - missingRev) / totalRev, 1e-12);
  assert.equal(laborOf(all, { ...MONTH_A, excludeMissing: true }), r2c(9500 * (totalRev - missingRev) / totalRev));
  // Vendor + exclusion: that vendor's costed revenue only; vendor shares with exclusion + the missing share = 1.
  const vendors = ['Vendor One', 'Calathea Collective', 'Mountain Crest Gardens'];
  const exShares = vendors.map(v => laborAllocationShare(all, { ...MONTH_A, vendorFilter: v, excludeMissing: true }).share);
  near(exShares.reduce((s, x) => s + x, 0) + missingRev / totalRev, 1, 1e-12);
  // The excluded products never pass their labor to the rest.
  assert.ok(laborOf(all, { ...MONTH_A, excludeMissing: true }) < 9500);
});

test('labor: an unfiltered selection keeps the full period labor (unchanged behaviour)', () => {
  const all = month();
  const d = prepareDecision(all, MONTH_A);
  assert.equal(d.labor.share, 1); assert.equal(d.labor.filtered, false);
  const legacy = summarizeScenario(selectScenarioLines(all, MONTH_A), MONTH_A);
  const now = summarizeScenario(d.lines, d.assumptions);
  assert.equal(now.scenario.labor, legacy.scenario.labor);
  assert.equal(now.scenario.operatingProfit, legacy.scenario.operatingProfit);
});

test('shipping split by revenue share is reported as allocated', () => {
  const lines = [
    L({ order: '#1', vendor: 'Vendor Two', sku: 'B', base: 300, cogs: 100, shipCollected: 20, shipPaid: 16 }),
    L({ order: '#1', vendor: 'Vendor One', sku: 'A', base: 100, cogs: 40 }),
    L({ order: '#2', vendor: 'Vendor One', sku: 'C', base: 50, cogs: 20, shipCollected: 6, shipPaid: 7 }),
  ];
  const d = prepareDecision(lines, { vendorFilter: 'Vendor One' });
  assert.deepEqual(d.shippingSplit, { orders: 1, collected: 5, expense: 4 });
  assert.deepEqual(prepareDecision(lines, {}).shippingSplit, { orders: 0, collected: 0, expense: 0 });
});
