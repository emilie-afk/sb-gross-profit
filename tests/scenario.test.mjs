/**
 * Scenario calculator test suite.
 * Run with:  node --test tests/
 *
 * Covers the 24 required cases plus the reconciliation identities.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { calculate, parseCSV, parseShipStation, normalizeOrderNumber,
         summarize, SUB_RENEWAL_CHANNEL } from '../js/calculator.js';
import {
  summarizeScenario, calculateAllowableCogs, calculateSingleProductTargetCost,
  resolveEffectiveDiscount, allocateLabor, isDiscountEligible, calculateScenarioLine,
} from '../js/scenario.js';
import { row, ssRow, VENDOR_COSTS } from './fixtures.mjs';

const near = (a, b, tol = 0.02, msg = '') =>
  assert.ok(Math.abs(a - b) <= tol, `${msg} expected ≈${b}, got ${a}`);

function calc(rows, { ship = new Map(), options = {}, hpd = null } = {}) {
  return calculate(rows, ship, {}, {}, {}, {}, {}, {}, hpd, {}, VENDOR_COSTS, null, options);
}

// A small but representative July order book.
function baseOrders() {
  return [
    // Calathea watering can, $45, 10% historical discount already applied
    row({ Name: '#912351', 'Lineitem sku': 'CC-WC-PLANT-DAD', Vendor: 'Calathea Collective',
          'Lineitem name': 'White Watering Can - Plant Dad', 'Lineitem price': '45.00',
          'Lineitem discount': '4.50', 'Lineitem quantity': '1',
          Shipping: '9.00', Subtotal: '40.50', Taxes: '0', Total: '49.50' }),
    // Surfside heart, no historical discount
    row({ Name: '#912352', 'Lineitem sku': 'SUR-HEART-SMALL', Vendor: 'Surfside Arrangement',
          'Lineitem name': 'Small Heart', 'Lineitem price': '80.00', 'Lineitem quantity': '1',
          Shipping: '12.00', Subtotal: '80.00', Total: '92.00' }),
    // Lively Good fiddle leaf
    row({ Name: '#912353', 'Lineitem sku': 'PL_FLF_4IN1', Vendor: 'Lively Root',
          'Lineitem name': 'Fiddle Leaf Fig Tree', 'Lineitem price': '67.08',
          'Lineitem quantity': '1', Shipping: '15.00', Subtotal: '67.08', Total: '82.08' }),
  ];
}

const SS = new Map([['912351', 7.5], ['912352', 11.0], ['912353', 14.0]]);

// ── 1. Sitewide discount only ────────────────────────────────────────────────
test('1 · sitewide discount applies to every eligible product', () => {
  const lines = calc(baseOrders(), { ship: SS });
  const s = summarizeScenario(lines, { sitewideDiscount: 0.10, adRate: 0, monthlyLabor: 0 });
  near(s.scenario.baseMerchRevenue, 45 + 80 + 67.08);
  near(s.scenario.scenarioRevenue, (45 + 80 + 67.08) * 0.9);
  for (const l of s.lines) assert.equal(l.effectiveDiscount, 0.10);
});

// ── 2. Vendor override replaces sitewide ─────────────────────────────────────
test('2 · a vendor override replaces the sitewide discount for that vendor', () => {
  const lines = calc(baseOrders(), { ship: SS });
  const s = summarizeScenario(lines, {
    sitewideDiscount: 0.10, adRate: 0, monthlyLabor: 0,
    vendorDiscounts: { 'Calathea Collective': 0.17 } });
  const cc = s.lines.find(l => l.vendorKey === 'Calathea Collective');
  const sur = s.lines.find(l => l.vendorKey === 'Surfside Arrangement');
  assert.equal(cc.effectiveDiscount, 0.17);
  assert.equal(sur.effectiveDiscount, 0.10);
  near(cc.scenarioRevenue, 45 * 0.83);          // 17%, never 27%
  assert.notEqual(cc.effectiveDiscount, 0.27);
});

// ── 3. Two vendor overrides in one scenario ──────────────────────────────────
test('3 · two vendor overrides coexist', () => {
  const lines = calc(baseOrders(), { ship: SS });
  const s = summarizeScenario(lines, {
    sitewideDiscount: 0.10, adRate: 0, monthlyLabor: 0,
    vendorDiscounts: { 'Calathea Collective': 0.17, 'Surfside Arrangement': 0.05 } });
  const by = Object.fromEntries(s.lines.map(l => [l.vendorKey, l.effectiveDiscount]));
  assert.deepEqual(by, {
    'Calathea Collective': 0.17, 'Surfside Arrangement': 0.05, 'Lively Good': 0.10 });
});

// ── 4. Subscriptions are eligible ────────────────────────────────────────────
test('4 · a subscription line receives the scenario discount', () => {
  const rows = [row({ Name: '#912360', 'Lineitem sku': 'SUB2-1-3', Vendor: 'Succulents Box',
                      'Lineitem name': '3-Month Succulent Subscription', 'Lineitem price': '60.00',
                      'Lineitem quantity': '1', Shipping: '20.97', Subtotal: '60', Total: '80.97' })];
  const lines = calc(rows);
  const s = summarizeScenario(lines, { sitewideDiscount: 0.10, adRate: 0, monthlyLabor: 0 });
  assert.equal(s.lines[0].discountEligible, true);
  assert.equal(s.lines[0].effectiveDiscount, 0.10);
  near(s.lines[0].scenarioRevenue, 54);
});

// ── 5. Gift cards excluded ───────────────────────────────────────────────────
test('5 · gift cards are excluded from the scenario discount', () => {
  const rows = [row({ Name: '#912361', 'Lineitem sku': 'GC50', Vendor: 'Succulents Box',
                      'Lineitem name': 'Gift Card', 'Lineitem price': '50.00',
                      Subtotal: '50', Total: '50' })];
  const lines = calc(rows);
  const s = summarizeScenario(lines, { sitewideDiscount: 0.25, adRate: 0, monthlyLabor: 0 });
  assert.equal(s.lines[0].discountEligible, false);
  assert.equal(s.lines[0].effectiveDiscount, 0);
  near(s.lines[0].scenarioRevenue, 50);
});

// ── 6. Route excluded ────────────────────────────────────────────────────────
test('6 · Route shipping protection is excluded and stays pass-through', () => {
  const rows = [row({ Name: '#912362', 'Lineitem sku': 'ROUTEINS', Vendor: 'Route',
                      'Lineitem name': 'Shipping Protection by Route', 'Lineitem price': '1.85',
                      Subtotal: '1.85', Total: '1.85' })];
  const lines = calc(rows);
  assert.equal(lines[0].unitCost, 1.85);                 // pass-through cost
  const s = summarizeScenario(lines, { sitewideDiscount: 0.5, adRate: 0, monthlyLabor: 0 });
  assert.equal(s.lines[0].discountEligible, false);
  near(s.lines[0].scenarioRevenue, 1.85);
  near(s.scenario.grossProfit, 0);                        // revenue == cost
});

// ── 7. Free sample keeps COGS ────────────────────────────────────────────────
test('7 · influencer free sample has zero revenue but retains COGS', () => {
  const rows = [row({ Name: '#912363', 'Lineitem sku': 'CC-WC-PLANT-DAD',
                      Vendor: 'Calathea Collective', 'Lineitem name': 'White Watering Can',
                      'Lineitem price': '45.00', Subtotal: '45.00', Total: '0',
                      'Discount Code': 'INFLUENCER' })];
  const lines = calc(rows);
  assert.equal(lines[0].lineRevenue, 0);
  assert.equal(lines[0].lineCogs, 22.5);
  const s = summarizeScenario(lines, { sitewideDiscount: 0.10, adRate: 0, monthlyLabor: 0 });
  assert.equal(s.lines[0].discountEligible, false);
  near(s.scenario.scenarioRevenue, 0);
  near(s.scenario.cogs, 22.5);
});

// ── 8. Pure HPD shipping ─────────────────────────────────────────────────────
test('8 · a pure HPD order passes shipping through: contribution is zero', () => {
  const rows = [row({ Name: '#912370', 'Lineitem sku': 'FH-MONSTERA',
                      Vendor: 'House Plant Dropship', 'Lineitem name': 'Monstera 6in',
                      'Lineitem price': '59.00', Shipping: '18.95', Subtotal: '59', Total: '77.95' })];
  const lines = calc(rows);                                   // no ShipStation match at all
  assert.equal(lines[0].shipCollected, 18.95);
  assert.equal(lines[0].shipPaid, 18.95);
  assert.equal(lines[0].shipDelta, 0);
  assert.match(lines[0].shipNote, /pass-through/);
});

test('8b · a mixed HPD order uses ShipStation for the non-HPD shipment', () => {
  const rows = [
    row({ Name: '#912371', 'Lineitem sku': 'FH-MONSTERA', Vendor: 'House Plant Dropship',
          'Lineitem name': 'Monstera', 'Lineitem price': '59.00', Shipping: '25.00',
          Subtotal: '99', Total: '124.00' }),
    row({ Name: '#912371', 'Lineitem sku': 'MG-SUCC', Vendor: 'Succulents Box',
          'Lineitem name': 'Succulent', 'Lineitem price': '40.00', Shipping: '25.00' }),
  ];
  const lines = calc(rows, { ship: new Map([['912371', 9.0]]) });
  assert.equal(lines[0].shipPaidSS, 9.0);
  assert.equal(lines[0].shipPaidHP, 16.0);          // max(0, 25 − 9)
  assert.equal(lines[0].shipPaid, 25.0);
  assert.match(lines[0].shipNote, /Mixed HPD shipping/);
});

// ── 9 / 10 / 11 / 12. ShipStation handling ───────────────────────────────────
test('9 · a shipment repeated across item rows is counted once', () => {
  const { costs } = parseShipStation([
    ssRow({ 'Shipment #': 'S1', 'Order #': '912351', 'Shipping Paid': '7.50', 'Item SKU': 'A' }),
    ssRow({ 'Shipment #': 'S1', 'Order #': '912351', 'Shipping Paid': '7.50', 'Item SKU': 'B' }),
    ssRow({ 'Shipment #': 'S1', 'Order #': '912351', 'Shipping Paid': '7.50', 'Item SKU': 'C' }),
  ]);
  assert.equal(costs.get('912351'), 7.5);
});

test('10 · multiple shipments for one order are summed', () => {
  const { costs, shipments } = parseShipStation([
    ssRow({ 'Shipment #': 'S1', 'Order #': '912351', 'Shipping Paid': '7.50', 'Item SKU': 'A' }),
    ssRow({ 'Shipment #': 'S1', 'Order #': '912351', 'Shipping Paid': '7.50', 'Item SKU': 'B' }),
    ssRow({ 'Shipment #': 'S2', 'Order #': '912351', 'Shipping Paid': '4.25', 'Item SKU': 'C' }),
  ]);
  assert.equal(costs.get('912351'), 11.75);
  assert.equal(shipments.get('912351').length, 2);
});

test('10b · Rate is the expense; Shipping Paid is only a fallback', () => {
  // Real exports carry both. 'Shipping Paid' is what the customer paid (it
  // equals Shopify's Shipping), so booking it as expense would turn shipping
  // revenue into a cost.
  const both = parseShipStation([
    { 'Shipment #': 'S1', 'Order #': '912351', 'Rate': '5.16', 'Shipping Paid': '5.99',
      'Item SKU': 'A' },
  ]);
  assert.equal(both.costs.get('912351'), 5.16);
  assert.equal(both.costColumnUsed, 'Rate');

  const onlyPaid = parseShipStation([
    { 'Shipment #': 'S1', 'Order #': '912351', 'Shipping Paid': '5.99', 'Item SKU': 'A' },
  ]);
  assert.equal(onlyPaid.costs.get('912351'), 5.99);
  assert.equal(onlyPaid.costColumnUsed, 'Shipping Paid');
});

test('10c · a shipment with no rate is counted as a gap, not as free shipping', () => {
  const res = parseShipStation([
    { 'Shipment #': 'S1', 'Order #': '1', 'Rate': '0.00', 'Shipping Paid': '4.99', 'Item SKU': 'A' },
    { 'Shipment #': 'S2', 'Order #': '2', 'Rate': '7.25', 'Shipping Paid': '4.99', 'Item SKU': 'B' },
  ]);
  assert.equal(res.totalShipments, 2);
  assert.equal(res.zeroCostShipments, 1);
});

test('11 · Shopify "#912351" joins ShipStation "912351"', () => {
  assert.equal(normalizeOrderNumber('#912351'), '912351');
  assert.equal(normalizeOrderNumber('912351'), '912351');
  const rows = [row({ Name: '#912351', 'Lineitem sku': 'CC-WC-PLANT-DAD',
                      Vendor: 'Calathea Collective', 'Lineitem price': '45.00',
                      Shipping: '9.00', Subtotal: '45', Total: '54' })];
  const { costs } = parseShipStation([
    ssRow({ 'Shipment #': 'S9', 'Order #': '912351', 'Shipping Paid': '7.50' })]);
  const lines = calc(rows, { ship: costs });
  assert.equal(lines[0].shipPaid, 7.5);
});

test('12 · an order with no ShipStation match is reported, not invented', () => {
  const rows = [row({ Name: '#999999', 'Lineitem sku': 'CC-WC-PLANT-DAD',
                      Vendor: 'Calathea Collective', 'Lineitem price': '45.00',
                      Shipping: '9.00', Subtotal: '45', Total: '54' })];
  const lines = calc(rows, { ship: new Map() });
  assert.equal(lines[0].shipPaid, null);
  assert.equal(lines[0].shipDelta, null);
});

// ── 13. Missing product cost ─────────────────────────────────────────────────
test('13 · a missing cost is never treated as zero', () => {
  const rows = [
    row({ Name: '#912380', 'Lineitem sku': 'UNKNOWN-SKU-1', Vendor: 'Some New Vendor',
          'Lineitem name': 'Mystery item', 'Lineitem price': '30.00',
          Shipping: '0', Subtotal: '30', Total: '30' }),
    row({ Name: '#912381', 'Lineitem sku': 'CC-WC-PLANT-DAD', Vendor: 'Calathea Collective',
          'Lineitem name': 'Watering Can', 'Lineitem price': '45.00',
          Shipping: '0', Subtotal: '45', Total: '45' }),
  ];
  const lines = calc(rows);
  assert.equal(lines[0].unitCost, null);
  assert.equal(lines[0].lineCogs, null);
  assert.equal(lines[0].missingCost, true);
  const s = summarizeScenario(lines, { sitewideDiscount: 0.10, adRate: 0, monthlyLabor: 0 });
  assert.equal(s.incomplete, true);
  assert.equal(s.missingCostLines.length, 1);
  assert.equal(s.coverage.soldSkus, 2);
  assert.equal(s.coverage.matchedSkus, 1);
  near(s.coverage.skuPct, 50);
  near(s.scenario.cogs, 22.5);                    // the unknown SKU adds no phantom $0 product
});

// ── 14. Cancelled orders ─────────────────────────────────────────────────────
test('14 · cancelled orders are excluded from profitability', () => {
  const rows = [
    ...baseOrders(),
    row({ Name: '#912390', 'Lineitem sku': 'CC-WC-PLANT-DAD', Vendor: 'Calathea Collective',
          'Lineitem price': '45.00', Shipping: '9.00', Subtotal: '45', Total: '54',
          'Cancelled at': '2026-07-06 09:00:00 -0700' }),
  ];
  const lines = calc(rows, { ship: SS });
  assert.equal(lines.some(l => l.orderNum === '#912390'), false);
  assert.equal(lines.length, 3);
});

// ── 15. Order-level refund allocation ────────────────────────────────────────
test('15 · an order-level refund is prorated across lines by net revenue share', () => {
  const rows = [
    row({ Name: '#912400', 'Lineitem sku': 'CC-WC-PLANT-DAD', Vendor: 'Calathea Collective',
          'Lineitem price': '60.00', Shipping: '0', Subtotal: '100', Total: '100',
          'Refunded Amount': '25.00' }),
    row({ Name: '#912400', 'Lineitem sku': 'SUR-HEART-SMALL', Vendor: 'Surfside Arrangement',
          'Lineitem price': '40.00', Shipping: '0' }),
  ];
  const lines = calc(rows);
  near(lines[0].lineRevenue, 60 - 15);        // 60% of 25
  near(lines[1].lineRevenue, 40 - 10);        // 40% of 25
  near(lines[0].refundAllocated + lines[1].refundAllocated, 25);
  assert.equal(lines[0].orderRefund, 25);
});

// ── 16 / 17. Labor allocation ────────────────────────────────────────────────
test('16 · a complete calendar month allocates one whole monthly labor amount', () => {
  const l = allocateLabor({ monthlyLabor: 9500, dateFrom: '2026-07-01', dateTo: '2026-07-31' });
  assert.equal(l.allocated, 9500);
  assert.equal(l.months, 1);
  assert.equal(l.method, 'whole_calendar_months');
  const two = allocateLabor({ monthlyLabor: 9500, dateFrom: '2026-06-01', dateTo: '2026-07-31' });
  assert.equal(two.allocated, 19000);
  assert.equal(two.months, 2);
});

test('17 · a partial period prorates labor by inclusive days / 30.4375', () => {
  const l = allocateLabor({ monthlyLabor: 9500, dateFrom: '2026-07-01', dateTo: '2026-07-15' });
  assert.equal(l.method, 'prorated_days');
  assert.equal(l.days, 15);
  near(l.allocated, 9500 * 15 / 30.4375);
});

// ── 18. Negative operating margin ────────────────────────────────────────────
test('18 · losses are shown, never clamped to zero', () => {
  const lines = calc(baseOrders(), { ship: SS });
  const s = summarizeScenario(lines, {
    sitewideDiscount: 0.40, adRate: 0.30, monthlyLabor: 9500,
    dateFrom: '2026-07-01', dateTo: '2026-07-31' });
  assert.ok(s.scenario.operatingProfit < 0, 'operating profit should be negative');
  assert.ok(s.scenario.operatingMargin < 0, 'operating margin should be negative');
});

// ── 19. Maximum allowable COGS below zero ────────────────────────────────────
test('19 · an unreachable target reports max allowable COGS below zero', () => {
  const lines = calc(baseOrders(), { ship: SS });
  const s = summarizeScenario(lines, {
    sitewideDiscount: 0.40, adRate: 0.30, monthlyLabor: 9500, targetMargin: 0.20,
    dateFrom: '2026-07-01', dateTo: '2026-07-31' });
  const res = calculateAllowableCogs(s);
  assert.ok(res.maxCogs < 0);
  assert.equal(res.achievable, false);
  assert.match(res.note, /cannot be reached/);
});

test('19b · a reachable target reports the required reduction', () => {
  const lines = calc(baseOrders(), { ship: SS });
  const s = summarizeScenario(lines, {
    sitewideDiscount: 0.10, adRate: 0.15, monthlyLabor: 0, targetMargin: 0.20 });
  const res = calculateAllowableCogs(s);
  assert.ok(res.maxCogs > 0);
  near(res.reductionDollars, res.currentCogs - res.maxCogs);
  assert.equal(res.achievable, true);
});

// ── 20. Product with no historical sales ─────────────────────────────────────
test('20 · the standalone calculator works for a product with no sales', () => {
  const r = calculateSingleProductTargetCost({
    vendor: 'Calathea Collective', sku: 'CC-NEW-THING', sellingPrice: 100,
    currentUnitCost: 55, discountPct: 0.10, adPct: 0.15,
    shipCollected: 0, shipExpense: 8, laborPerUnit: 2, targetMargin: 0.20 });
  near(r.discountedPrice, 90);
  near(r.adExpense, 13.5);
  near(r.targetProfit, 18);
  near(r.maxAllowableCost, 90 - 8 - 13.5 - 2 - 18);   // 48.50
  near(r.profitAtCurrentCost, 90 - 8 - 13.5 - 2 - 55);
  assert.equal(r.targetAchieved, false);
  near(r.requiredReduction, 55 - 48.5);
  assert.match(r.note, /does not use historical product mix/);
});

// ── 21. Aggregation reconciles ───────────────────────────────────────────────
test('21 · vendor and SKU aggregation reconcile to the overall scenario', () => {
  const rows = [
    ...baseOrders(),
    row({ Name: '#912351', 'Lineitem sku': 'SUR-HEART-SMALL', Vendor: 'Surfside Arrangement',
          'Lineitem name': 'Small Heart', 'Lineitem price': '80.00', Shipping: '9.00' }),
    row({ Name: '#912401', 'Lineitem sku': 'PL_FLF_4IN1', Vendor: 'Lively Root',
          'Lineitem price': '67.08', Shipping: '0', Subtotal: '67.08', Total: '67.08' }),
  ];
  const lines = calc(rows, { ship: SS });
  const s = summarizeScenario(lines, {
    sitewideDiscount: 0.12, adRate: 0.15, monthlyLabor: 9500, targetMargin: 0.10,
    dateFrom: '2026-07-01', dateTo: '2026-07-31',
    vendorDiscounts: { 'Calathea Collective': 0.17 } });

  for (const c of s.reconciliation.checks) {
    assert.ok(c.ok, `${c.label}: got ${c.got}, want ${c.want}`);
  }
  assert.equal(s.reconciliation.ok, true);
});

// ── 22. Current column is immune to scenario controls ────────────────────────
test('22 · the current-actual column does not move when scenario controls change', () => {
  const lines = calc(baseOrders(), { ship: SS });
  const a = summarizeScenario(lines, { sitewideDiscount: 0.05, adRate: 0.15, monthlyLabor: 9500,
                                       dateFrom: '2026-07-01', dateTo: '2026-07-31' });
  const b = summarizeScenario(lines, { sitewideDiscount: 0.35, adRate: 0.15, monthlyLabor: 9500,
                                       dateFrom: '2026-07-01', dateTo: '2026-07-31',
                                       vendorDiscounts: { 'Lively Good': 0.5 } });
  for (const k of ['baseMerchRevenue', 'currentRevenue', 'currentDiscount', 'cogs',
                   'shipCollected', 'shipExpense', 'grossProfit', 'adExpense',
                   'labor', 'operatingProfit']) {
    assert.equal(a.current[k], b.current[k], `current.${k} must not change`);
  }
  assert.notEqual(a.scenario.scenarioRevenue, b.scenario.scenarioRevenue);
});

// ── 23. Scenario discount replaces the historical discount ───────────────────
test('23 · the scenario discount replaces, and does not stack on, the historical one', () => {
  // Historical: $45 list, $4.50 discount → $40.50 net.
  const rows = [row({ Name: '#912351', 'Lineitem sku': 'CC-WC-PLANT-DAD',
                      Vendor: 'Calathea Collective', 'Lineitem price': '45.00',
                      'Lineitem discount': '4.50', Shipping: '0',
                      Subtotal: '40.50', Total: '40.50' })];
  const lines = calc(rows);
  near(lines[0].lineRevenue, 40.5);
  const s = summarizeScenario(lines, { sitewideDiscount: 0.20, adRate: 0, monthlyLabor: 0 });
  near(s.scenario.scenarioRevenue, 36);                 // 45 × 0.80
  assert.notEqual(Math.round(s.scenario.scenarioRevenue * 100), Math.round(40.5 * 0.8 * 100));
});

// ── 24. Vendor discount replaces sitewide (unit level) ───────────────────────
test('24 · resolveEffectiveDiscount replaces rather than stacks', () => {
  assert.equal(resolveEffectiveDiscount('Calathea Collective', 0.10,
    { 'Calathea Collective': 0.17 }), 0.17);
  assert.equal(resolveEffectiveDiscount('Lively Good', 0.10,
    { 'Calathea Collective': 0.17 }), 0.10);
  assert.equal(resolveEffectiveDiscount('Lively Good', 0.10, { 'Lively Good': 0 }), 0);
  assert.equal(resolveEffectiveDiscount('', 0.10, {}), 0.10);
});

// ── Extra guards ─────────────────────────────────────────────────────────────
test('gross profit never silently includes advertising or labor', () => {
  const lines = calc(baseOrders(), { ship: SS });
  const s = summarizeScenario(lines, { sitewideDiscount: 0.10, adRate: 0.15, monthlyLabor: 9500,
                                       dateFrom: '2026-07-01', dateTo: '2026-07-31' });
  near(s.scenario.grossProfit,
       s.scenario.scenarioRevenue + s.scenario.shipCollected - s.scenario.cogs - s.scenario.shipExpense);
  near(s.scenario.operatingProfit,
       s.scenario.grossProfit - s.scenario.adExpense - s.scenario.labor);
});

test('advertising is charged on product revenue only, never on shipping collected', () => {
  const lines = calc(baseOrders(), { ship: SS });
  const s = summarizeScenario(lines, { sitewideDiscount: 0, adRate: 0.10, monthlyLabor: 0 });
  near(s.scenario.adExpense, s.scenario.scenarioRevenue * 0.10);
  assert.ok(s.scenario.shipCollected > 0);
});

test('operating margin is unavailable rather than NaN when revenue is zero', () => {
  const rows = [row({ Name: '#912410', 'Lineitem sku': 'CC-WC-PLANT-DAD',
                      Vendor: 'Calathea Collective', 'Lineitem price': '45.00',
                      Subtotal: '45', Total: '0', 'Discount Code': 'sample' })];
  const lines = calc(rows);
  const s = summarizeScenario(lines, { sitewideDiscount: 0.1, adRate: 0.15, monthlyLabor: 0 });
  assert.equal(s.scenario.totalRevenue, 0);
  assert.equal(s.scenario.operatingMargin, null);
});

test('shipping collected and expense stay at historical actuals in a scenario', () => {
  const lines = calc(baseOrders(), { ship: SS });
  const a = summarizeScenario(lines, { sitewideDiscount: 0, adRate: 0, monthlyLabor: 0 });
  const b = summarizeScenario(lines, { sitewideDiscount: 0.45, adRate: 0, monthlyLabor: 0 });
  assert.equal(a.scenario.shipCollected, b.scenario.shipCollected);
  assert.equal(a.scenario.shipExpense, b.scenario.shipExpense);
  // C3: the Lively Root order is a pass-through (expense = the $15 collected);
  // its synthetic ShipStation cost is not used. The legacy engine used it.
  near(a.scenario.shipExpense, 7.5 + 11 + 15);
  const legacy = summarizeScenario(calc(baseOrders(), { ship: SS, options: { shippingRules: 'legacy' } }), { sitewideDiscount: 0, adRate: 0, monthlyLabor: 0 });
  near(legacy.scenario.shipExpense, 7.5 + 11 + 14);
});

test('vendor costs are resolved per vendor and never borrowed across vendors', () => {
  const rows = [row({ Name: '#912420', 'Lineitem sku': 'CC-WC-PLANT-DAD',
                      Vendor: 'Surfside Arrangement', 'Lineitem name': 'Not a real pairing',
                      'Lineitem price': '45.00', Subtotal: '45', Total: '45' })];
  const lines = calc(rows);
  assert.equal(lines[0].unitCost, null, 'Calathea SKU must not pick up a Surfside cost');
  assert.equal(lines[0].missingCost, true);
});

test('a vendor SKU containing "+" is one product, not a bundle', () => {
  // Regression from the July export: SUR-WHITEPOT-ROSETTE+DONKEY was being split
  // on '+' by the composite-bundle rule and reported as a missing cost.
  const rows = [row({ Name: '#912430', 'Lineitem sku': 'SUR-WHITEPOT-ROSETTE+DONKEY',
                      Vendor: 'Surfside Arrangement',
                      'Lineitem name': 'White Pot - Rosettes + Donkey Tail',
                      'Lineitem price': '38.00', Subtotal: '38', Total: '38' })];
  const lines = calc(rows);
  assert.equal(lines[0].unitCost, 19.0);
  assert.equal(lines[0].costSource, 'Surfside Arrangement sheet');
  assert.equal(lines[0].missingCost, false);
});

test('a genuine composite MCG bundle still sums both halves', () => {
  const lines = calculate(
    [row({ Name: '#912431', 'Lineitem sku': 'S3KY2997+EEZZ7650', Vendor: 'Succulents Box',
           'Lineitem name': 'Plant + pot', 'Lineitem price': '30.00',
           Subtotal: '30', Total: '30' })],
    new Map(), { 'S3KY2997': 6.0, 'EEZZ7650': 2.0 }, {}, {}, {}, {}, {}, null, {},
    VENDOR_COSTS, null, {});
  assert.equal(lines[0].unitCost, 8.0);
  assert.match(lines[0].costSource, /^Bundle/);
});

test('every line carries its audit trail', () => {
  const lines = calc(baseOrders(), { ship: SS });
  for (const l of lines) {
    for (const k of ['vendorKey', 'sku', 'product', 'unitCost', 'costSource',
                     'costMatchType', 'missingCost']) {
      assert.ok(k in l, `line is missing ${k}`);
    }
  }
  assert.equal(lines[0].costMatchType, 'exact_sku');
});

test('isDiscountEligible / calculateScenarioLine are pure and side-effect free', () => {
  const line = { sku: 'CC-X', vendor: 'Calathea Collective', qty: 2, unitPrice: 10,
                 baseMerchRevenue: 20, lineRevenue: 18, lineCogs: 9 };
  const snapshot = JSON.stringify(line);
  const out = calculateScenarioLine(line, { sitewideDiscount: 0.5 });
  assert.equal(JSON.stringify(line), snapshot);
  assert.equal(isDiscountEligible(line), true);
  near(out.scenarioRevenue, 10);
});

// ── Regressions found in the Jul–Sep 2026 exports ────────────────────────────

test('a species SKU containing "x" before digits is not a multipack', () => {
  // S2Kx1125 is one $7.20 cactus. The old rule read it as "S2K" × 1125 plants
  // and priced it at ~$3,769, which also dragged the order into the top MCG
  // volume-discount tier.
  const lines = calculate(
    [row({ Name: '#915400', 'Lineitem sku': 'S2Kx1125', Vendor: 'Seedville USA',
           'Lineitem name': 'Crassula Ivory Towers - 2 inch', 'Lineitem price': '7.20',
           Subtotal: '7.20', Total: '7.20' })],
    new Map(), {}, {}, {}, {}, {}, {}, null, {}, null, null, {});
  assert.equal(lines[0].unitCost, 4.00, 'should fall back to the plain 2" tier');
  assert.equal(lines[0].costSource, 'MCG tier (2")');
});

test('a genuine multipack SKU still multiplies the tier', () => {
  const lines = calculate(
    [row({ Name: '#915401', 'Lineitem sku': 'S2JY1492x2', Vendor: 'Succulents Box',
           'Lineitem name': 'Succulent 2-pack', 'Lineitem price': '14.40',
           Subtotal: '14.40', Total: '14.40' })],
    new Map(), {}, {}, {}, {}, {}, {}, null, {}, null, null, {});
  // $4 × 2 = $8, less the 2-plant MCG volume discount of $0.25/plant.
  assert.equal(lines[0].unitCost, 7.50);
  assert.match(lines[0].costSource, /×2/);
  assert.match(lines[0].costSource, /vol disc, 2 plants/);
});

test('parseCSV keeps records whose quoted fields contain newlines intact', () => {
  // Shopify Notes / Note Attributes routinely contain newlines, and the columns
  // after them include Vendor, Cancelled at, Refunded Amount and Lineitem discount.
  const csv = [
    'Name,Lineitem sku,Notes,Vendor,Lineitem discount',
    '#1,SKU-A,"line one',
    'line two",Calathea Collective,1.50',
    '#2,SKU-B,plain,Surfside Arrangement,0',
  ].join('\n');
  const rows = parseCSV(csv);
  assert.equal(rows.length, 2, 'the multi-line record must stay one row');
  assert.equal(rows[0].Notes, 'line one\nline two');
  assert.equal(rows[0].Vendor, 'Calathea Collective');
  assert.equal(rows[0]['Lineitem discount'], '1.50');
  assert.equal(rows[1].Vendor, 'Surfside Arrangement');
});

// ── Prepaid subscription deliveries are separated and labelled ───────────────

test('a prepaid subscription delivery is flagged and kept out of its sales channel', () => {
  const lines = calc([
    // The order that collected the money
    row({ Name: '#480001', 'Lineitem sku': 'SUB2-2-6', Vendor: 'Succulents Box',
          'Lineitem name': '2 succulents/month - 6 month Subscription',
          'Lineitem price': '120.00', Subtotal: '120', Total: '120', Source: 'web' }),
    // A later delivery leg: no revenue, real fulfilment cost
    row({ Name: '#480002', 'Lineitem sku': 'SUB2-2-6', Vendor: 'Succulents Box',
          'Lineitem name': '2 succulents/month - 6 month Subscription',
          'Lineitem price': '0.00', Subtotal: '0', Total: '0', Source: '294517' }),
    // Ordinary sale through the same channel
    row({ Name: '#480003', 'Lineitem sku': 'CC-WC-PLANT-DAD', Vendor: 'Calathea Collective',
          'Lineitem name': 'White Watering Can', 'Lineitem price': '45.00',
          Subtotal: '45', Total: '45', Source: '294517' }),
  ]);
  const paid = lines.find(l => l.orderNum === '#480001');
  const leg  = lines.find(l => l.orderNum === '#480002');
  const sale = lines.find(l => l.orderNum === '#480003');

  assert.equal(paid.isSubRenewal, false, 'the paying order is not a renewal leg');
  assert.equal(leg.isSubRenewal, true);
  assert.ok(leg.lineCogs > 0, 'the delivery still carries its COGS');
  assert.equal(leg.lineRevenue, 0, 'revenue stays where it was collected');
  assert.equal(sale.isSubRenewal, false);

  const s = summarize(lines);
  // The real channel keeps only its real trade
  assert.equal(s.byChannel['294517'].revenue, 45);
  assert.ok(s.byChannel['294517'].gp > 0, 'no longer dragged negative');
  // The delivery legs sit in their own labelled bucket
  assert.ok(s.byChannel[SUB_RENEWAL_CHANNEL], 'renewal bucket exists');
  assert.equal(s.byChannel[SUB_RENEWAL_CHANNEL].revenue, 0);
  assert.ok(s.byChannel[SUB_RENEWAL_CHANNEL].gp < 0, 'cost-only by design');
});

test('separating renewals changes no total', () => {
  const rows = [
    row({ Name: '#480010', 'Lineitem sku': 'SUB2-2-6', Vendor: 'Succulents Box',
          'Lineitem name': 'sub', 'Lineitem price': '120.00', Subtotal: '120', Total: '120' }),
    row({ Name: '#480011', 'Lineitem sku': 'SUB2-2-6', Vendor: 'Succulents Box',
          'Lineitem name': 'sub', 'Lineitem price': '0.00', Subtotal: '0', Total: '0' }),
  ];
  const s = summarize(calc(rows));
  const channelRev = Object.values(s.byChannel).reduce((a, v) => a + v.revenue, 0);
  const channelGp  = Object.values(s.byChannel).reduce((a, v) => a + v.gp, 0);
  near(channelRev, s.productRevenue);
  near(channelGp, s.productRevenue - s.totalCogs);
});

// ── LindaMakes (added 2026-09-23) ────────────────────────────────────────────

test('LindaMakes costs resolve by vendor column and by LM- SKU prefix', () => {
  const lines = calc([
    row({ Name: '#480100', 'Lineitem sku': 'LM-VASE-PRO-BUD-RAINBOW', Vendor: 'LindaMakes',
          'Lineitem name': 'Rainbow Bud Vase', 'Lineitem price': '39.60',
          Subtotal: '39.60', Total: '39.60' }),
    // Vendor column blank or renamed — the LM- prefix still identifies the vendor.
    row({ Name: '#480101', 'Lineitem sku': 'LM-VASE-PRO-BUD-RAINBOW', Vendor: '',
          'Lineitem name': 'Rainbow Bud Vase', 'Lineitem price': '39.60',
          Subtotal: '39.60', Total: '39.60' }),
    // The tab's own header spells the vendor with a trailing s.
    row({ Name: '#480102', 'Lineitem sku': 'LM-VASE-PRO-BUD-RAINBOW', Vendor: 'LindaMakess',
          'Lineitem name': 'Rainbow Bud Vase', 'Lineitem price': '39.60',
          Subtotal: '39.60', Total: '39.60' }),
  ]);
  for (const l of lines) {
    assert.equal(l.unitCost, 19.8);
    assert.equal(l.vendorKey, 'LindaMakes');
    assert.equal(l.costSource, 'LindaMakes sheet');
    assert.equal(l.missingCost, false);
  }
});

test('a LindaMakes SKU never picks up another vendor\'s cost', () => {
  const lines = calc([
    row({ Name: '#480103', 'Lineitem sku': 'LM-VASE-PRO-BUD-RAINBOW',
          Vendor: 'Calathea Collective', 'Lineitem name': 'Not a real pairing',
          'Lineitem price': '39.60', Subtotal: '39.60', Total: '39.60' }),
  ]);
  assert.equal(lines[0].unitCost, null);
  assert.equal(lines[0].missingCost, true);
});

test('LindaMakes takes part in vendor discount overrides and vendor analysis', () => {
  const lines = calc([
    row({ Name: '#480104', 'Lineitem sku': 'LM-VASE-PRO-BUD-RAINBOW', Vendor: 'LindaMakes',
          'Lineitem name': 'Rainbow Bud Vase', 'Lineitem price': '40.00',
          Shipping: '6.00', Subtotal: '40', Total: '46' }),
    row({ Name: '#480105', 'Lineitem sku': 'CC-WC-PLANT-DAD', Vendor: 'Calathea Collective',
          'Lineitem name': 'Watering Can', 'Lineitem price': '45.00',
          Shipping: '9.00', Subtotal: '45', Total: '54' }),
  ], { ship: new Map([['480104', 5], ['480105', 7]]) });

  const s = summarizeScenario(lines, {
    sitewideDiscount: 0.10, adRate: 0.15, monthlyLabor: 0, targetMargin: 0.15,
    vendorDiscounts: { 'LindaMakes': 0.25 } });

  const lm = s.byVendor.find(v => v.vendor === 'LindaMakes');
  const cc = s.byVendor.find(v => v.vendor === 'Calathea Collective');
  assert.ok(lm, 'LindaMakes appears as its own vendor row');
  near(lm.scenarioRevenue, 30);          // 40 × 0.75 — the override, not 10%
  near(cc.scenarioRevenue, 40.5);        // 45 × 0.90 — sitewide
  near(lm.cogs, 19.8);
  assert.ok(lm.maxCogs !== undefined, 'reverse max-cost analysis covers the vendor');
  for (const c of s.reconciliation.checks) assert.ok(c.ok, c.label);
});
