/** Scenario engine on calculate() lines, and the calculator inputs it depends on. */
import { privateRules } from '../shared/privateRules.js';
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

function baseOrders() {
  return [
    row({ Name: '#912351', 'Lineitem sku': 'QCC-CX-HYSDT-PNS', Vendor: 'CC',
          'Lineitem name': 'Item A', 'Lineitem price': '45.00',
          'Lineitem discount': '4.50', 'Lineitem quantity': '1',
          Shipping: '9.00', Subtotal: '40.50', Taxes: '0', Total: '49.50' }),
    row({ Name: '#912352', 'Lineitem sku': 'QSA-EBHWD-PERMU', Vendor: 'SA',
          'Lineitem name': 'Item B', 'Lineitem price': '80.00', 'Lineitem quantity': '1',
          Shipping: '12.00', Subtotal: '80.00', Total: '92.00' }),
    row({ Name: '#912353', 'Lineitem sku': 'QLR_FERN_4IN1', Vendor: 'Rooted Partner',
          'Lineitem name': 'Item C', 'Lineitem price': '67.08',
          'Lineitem quantity': '1', Shipping: '15.00', Subtotal: '67.08', Total: '82.08' }),
  ];
}

const SS = new Map([['912351', 7.5], ['912352', 11.0], ['912353', 14.0]]);

test('1 · sitewide discount applies to every eligible product', () => {
  const lines = calc(baseOrders(), { ship: SS });
  const s = summarizeScenario(lines, { sitewideDiscount: 0.10, adRate: 0, monthlyLabor: 0 });
  near(s.scenario.baseMerchRevenue, 45 + 80 + 67.08);
  near(s.scenario.scenarioRevenue, (45 + 80 + 67.08) * 0.9);
  for (const l of s.lines) assert.equal(l.effectiveDiscount, 0.10);
});

test('2 · a vendor override replaces the sitewide discount for that vendor', () => {
  const lines = calc(baseOrders(), { ship: SS });
  const s = summarizeScenario(lines, {
    sitewideDiscount: 0.10, adRate: 0, monthlyLabor: 0,
    vendorDiscounts: { 'CC': 0.17 } });
  const cc = s.lines.find(l => l.vendorKey === 'CC');
  const sur = s.lines.find(l => l.vendorKey === 'SA');
  assert.equal(cc.effectiveDiscount, 0.17);
  assert.equal(sur.effectiveDiscount, 0.10);
  near(cc.scenarioRevenue, 45 * 0.83);
  assert.notEqual(cc.effectiveDiscount, 0.27);
});

test('3 · two vendor overrides coexist', () => {
  const lines = calc(baseOrders(), { ship: SS });
  const s = summarizeScenario(lines, {
    sitewideDiscount: 0.10, adRate: 0, monthlyLabor: 0,
    vendorDiscounts: { 'CC': 0.17, 'SA': 0.05 } });
  const by = Object.fromEntries(s.lines.map(l => [l.vendorKey, l.effectiveDiscount]));
  assert.deepEqual(by, {
    'CC': 0.17, 'SA': 0.05, 'LG': 0.10 });
});

test('4 · a subscription line takes the scenario discount', () => {
  const rows = [row({ Name: '#912360', 'Lineitem sku': 'SUB2-1-3', Vendor: 'House',
                      'Lineitem name': '3-Month Subscription', 'Lineitem price': '60.00',
                      'Lineitem quantity': '1', Shipping: '20.97', Subtotal: '60', Total: '80.97' })];
  const lines = calc(rows);
  const s = summarizeScenario(lines, { sitewideDiscount: 0.10, adRate: 0, monthlyLabor: 0 });
  assert.equal(s.lines[0].discountEligible, true);
  assert.equal(s.lines[0].effectiveDiscount, 0.10);
  near(s.lines[0].scenarioRevenue, 54);
});

test('5 · a rule-excluded line keeps its revenue', () => {
  const rows = [row({ Name: '#912361', 'Lineitem sku': 'GC50', Vendor: 'House',
                      'Lineitem name': 'Gift Card', 'Lineitem price': '50.00',
                      Subtotal: '50', Total: '50' })];
  const lines = calc(rows);
  const s = summarizeScenario(lines, { sitewideDiscount: 0.25, adRate: 0, monthlyLabor: 0 });
  assert.equal(s.lines[0].discountEligible, false);
  assert.equal(s.lines[0].effectiveDiscount, 0);
  near(s.lines[0].scenarioRevenue, 50);
});

test('6 · a pass-through line keeps its revenue', () => {
  const rows = [row({ Name: '#912362', 'Lineitem sku': 'ROUTEINS', Vendor: 'Fee',
                      'Lineitem name': 'Protection fee', 'Lineitem price': '1.85',
                      Subtotal: '1.85', Total: '1.85' })];
  const lines = calc(rows);
  assert.equal(lines[0].unitCost, 1.85);
  const s = summarizeScenario(lines, { sitewideDiscount: 0.5, adRate: 0, monthlyLabor: 0 });
  assert.equal(s.lines[0].discountEligible, false);
  near(s.lines[0].scenarioRevenue, 1.85);
  near(s.scenario.grossProfit, 0);
});

test('7 · a zero-revenue line keeps its COGS', () => {
  const rows = [row({ Name: '#912363', 'Lineitem sku': 'QCC-CX-HYSDT-PNS',
                      Vendor: 'CC', 'Lineitem name': 'Item A',
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

test('8 · a single-vendor dropship order: shipping expense equals collected', () => {
  const rows = [row({ Name: '#912370', 'Lineitem sku': 'FH-ITEMD',
                      Vendor: 'HPD', 'Lineitem name': 'Item D',
                      'Lineitem price': '59.00', Shipping: '18.95', Subtotal: '59', Total: '77.95' })];
  const lines = calc(rows);
  assert.equal(lines[0].shipCollected, 18.95);
  assert.equal(lines[0].shipPaid, 18.95);
  assert.equal(lines[0].shipDelta, 0);
  assert.match(lines[0].shipNote, /pass-through/);
});

test('8b · a mixed dropship order: rate for the shipped part, remainder for the dropship part', () => {
  const rows = [
    row({ Name: '#912371', 'Lineitem sku': 'FH-ITEMD', Vendor: 'HPD',
          'Lineitem name': 'Item D', 'Lineitem price': '59.00', Shipping: '25.00',
          Subtotal: '99', Total: '124.00' }),
    row({ Name: '#912371', 'Lineitem sku': 'MG-ITEME', Vendor: 'House',
          'Lineitem name': 'Item E', 'Lineitem price': '40.00', Shipping: '25.00' }),
  ];
  const lines = calc(rows, { ship: new Map([['912371', 9.0]]) });
  assert.equal(lines[0].shipPaidSS, 9.0);
  assert.equal(lines[0].shipPaidHP, 16.0);
  assert.equal(lines[0].shipPaid, 25.0);
  assert.match(lines[0].shipNote, /Mixed HPD shipping/);
});

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

test('11 · order numbers join with or without #', () => {
  assert.equal(normalizeOrderNumber('#912351'), '912351');
  assert.equal(normalizeOrderNumber('912351'), '912351');
  const rows = [row({ Name: '#912351', 'Lineitem sku': 'QCC-CX-HYSDT-PNS',
                      Vendor: 'CC', 'Lineitem price': '45.00',
                      Shipping: '9.00', Subtotal: '45', Total: '54' })];
  const { costs } = parseShipStation([
    ssRow({ 'Shipment #': 'S9', 'Order #': '912351', 'Shipping Paid': '7.50' })]);
  const lines = calc(rows, { ship: costs });
  assert.equal(lines[0].shipPaid, 7.5);
});

test('12 · an order without a shipping match has no expense', () => {
  const rows = [row({ Name: '#999999', 'Lineitem sku': 'QCC-CX-HYSDT-PNS',
                      Vendor: 'CC', 'Lineitem price': '45.00',
                      Shipping: '9.00', Subtotal: '45', Total: '54' })];
  const lines = calc(rows, { ship: new Map() });
  assert.equal(lines[0].shipPaid, null);
  assert.equal(lines[0].shipDelta, null);
});

test('13 · a missing cost is never treated as zero', () => {
  const rows = [
    row({ Name: '#912380', 'Lineitem sku': 'UNKNOWN-SKU-1', Vendor: 'Some New Vendor',
          'Lineitem name': 'Unknown item', 'Lineitem price': '30.00',
          Shipping: '0', Subtotal: '30', Total: '30' }),
    row({ Name: '#912381', 'Lineitem sku': 'QCC-CX-HYSDT-PNS', Vendor: 'CC',
          'Lineitem name': 'Item A', 'Lineitem price': '45.00',
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
  near(s.scenario.cogs, 22.5);
});

test('14 · cancelled orders are excluded from profitability', () => {
  const rows = [
    ...baseOrders(),
    row({ Name: '#912390', 'Lineitem sku': 'QCC-CX-HYSDT-PNS', Vendor: 'CC',
          'Lineitem price': '45.00', Shipping: '9.00', Subtotal: '45', Total: '54',
          'Cancelled at': '2026-07-06 09:00:00 -0700' }),
  ];
  const lines = calc(rows, { ship: SS });
  assert.equal(lines.some(l => l.orderNum === '#912390'), false);
  assert.equal(lines.length, 3);
});

test('15 · an order-level refund is prorated across lines by net revenue share', () => {
  const rows = [
    row({ Name: '#912400', 'Lineitem sku': 'QCC-CX-HYSDT-PNS', Vendor: 'CC',
          'Lineitem price': '60.00', Shipping: '0', Subtotal: '100', Total: '100',
          'Refunded Amount': '25.00' }),
    row({ Name: '#912400', 'Lineitem sku': 'QSA-EBHWD-PERMU', Vendor: 'SA',
          'Lineitem price': '40.00', Shipping: '0' }),
  ];
  const lines = calc(rows);
  near(lines[0].lineRevenue, 60 - 15);
  near(lines[1].lineRevenue, 40 - 10);
  near(lines[0].refundAllocated + lines[1].refundAllocated, 25);
  assert.equal(lines[0].orderRefund, 25);
});

test('16 · a complete calendar month allocates one whole monthly labor amount', () => {
  const l = allocateLabor({ monthlyLabor: 7300, dateFrom: '2026-07-01', dateTo: '2026-07-31' });
  assert.equal(l.allocated, 7300);
  assert.equal(l.months, 1);
  assert.equal(l.method, 'whole_calendar_months');
  const two = allocateLabor({ monthlyLabor: 7300, dateFrom: '2026-06-01', dateTo: '2026-07-31' });
  assert.equal(two.allocated, 14600);
  assert.equal(two.months, 2);
});

test('17 · a partial period prorates labor by inclusive days / 30.4375', () => {
  const l = allocateLabor({ monthlyLabor: 7300, dateFrom: '2026-07-01', dateTo: '2026-07-15' });
  assert.equal(l.method, 'prorated_days');
  assert.equal(l.days, 15);
  near(l.allocated, 7300 * 15 / 30.4375);
});

test('18 · losses are shown, never clamped to zero', () => {
  const lines = calc(baseOrders(), { ship: SS });
  const s = summarizeScenario(lines, {
    sitewideDiscount: 0.40, adRate: 0.30, monthlyLabor: 7300,
    dateFrom: '2026-07-01', dateTo: '2026-07-31' });
  assert.ok(s.scenario.operatingProfit < 0, 'operating profit should be negative');
  assert.ok(s.scenario.operatingMargin < 0, 'operating margin should be negative');
});

test('19 · an unreachable target reports max allowable COGS below zero', () => {
  const lines = calc(baseOrders(), { ship: SS });
  const s = summarizeScenario(lines, {
    sitewideDiscount: 0.40, adRate: 0.30, monthlyLabor: 7300, targetMargin: 0.20,
    dateFrom: '2026-07-01', dateTo: '2026-07-31' });
  const res = calculateAllowableCogs(s);
  assert.ok(res.maxCogs < 0);
  assert.equal(res.achievable, false);
  assert.match(res.note, /cannot be reached/);
});

test('19b · a reachable target reports the required reduction', () => {
  const lines = calc(baseOrders(), { ship: SS });
  const s = summarizeScenario(lines, {
    sitewideDiscount: 0.08, adRate: 0.15, monthlyLabor: 0, targetMargin: 0.20 });
  const res = calculateAllowableCogs(s);
  assert.ok(res.maxCogs > 0);
  near(res.reductionDollars, res.currentCogs - res.maxCogs);
  assert.equal(res.achievable, true);
});

test('20 · the standalone calculator works for a product with no sales', () => {
  const r = calculateSingleProductTargetCost({
    vendor: 'CC', sku: 'QCC-XAT-NGQRF', sellingPrice: 100,
    currentUnitCost: 55, discountPct: 0.10, adPct: 0.15,
    shipCollected: 0, shipExpense: 8, laborPerUnit: 2, targetMargin: 0.20 });
  near(r.discountedPrice, 90);
  near(r.adExpense, 13.5);
  near(r.targetProfit, 18);
  near(r.maxAllowableCost, 90 - 8 - 13.5 - 2 - 18);
  near(r.profitAtCurrentCost, 90 - 8 - 13.5 - 2 - 55);
  assert.equal(r.targetAchieved, false);
  near(r.requiredReduction, 55 - 48.5);
  assert.match(r.note, /does not use historical product mix/);
});

test('21 · vendor and SKU aggregation reconcile to the overall scenario', () => {
  const rows = [
    ...baseOrders(),
    row({ Name: '#912351', 'Lineitem sku': 'QSA-EBHWD-PERMU', Vendor: 'SA',
          'Lineitem name': 'Item B', 'Lineitem price': '80.00', Shipping: '9.00' }),
    row({ Name: '#912401', 'Lineitem sku': 'QLR_FERN_4IN1', Vendor: 'Rooted Partner',
          'Lineitem price': '67.08', Shipping: '0', Subtotal: '67.08', Total: '67.08' }),
  ];
  const lines = calc(rows, { ship: SS });
  const s = summarizeScenario(lines, {
    sitewideDiscount: 0.12, adRate: 0.15, monthlyLabor: 7300, targetMargin: 0.10,
    dateFrom: '2026-07-01', dateTo: '2026-07-31',
    vendorDiscounts: { 'CC': 0.17 } });

  for (const c of s.reconciliation.checks) {
    assert.ok(c.ok, `${c.label}: got ${c.got}, want ${c.want}`);
  }
  assert.equal(s.reconciliation.ok, true);
});

test('22 · the current-actual column does not move when scenario controls change', () => {
  const lines = calc(baseOrders(), { ship: SS });
  const a = summarizeScenario(lines, { sitewideDiscount: 0.05, adRate: 0.15, monthlyLabor: 7300,
                                       dateFrom: '2026-07-01', dateTo: '2026-07-31' });
  const b = summarizeScenario(lines, { sitewideDiscount: 0.35, adRate: 0.15, monthlyLabor: 7300,
                                       dateFrom: '2026-07-01', dateTo: '2026-07-31',
                                       vendorDiscounts: { 'LG': 0.5 } });
  for (const k of ['baseMerchRevenue', 'currentRevenue', 'currentDiscount', 'cogs',
                   'shipCollected', 'shipExpense', 'grossProfit', 'adExpense',
                   'labor', 'operatingProfit']) {
    assert.equal(a.current[k], b.current[k], `current.${k} must not change`);
  }
  assert.notEqual(a.scenario.scenarioRevenue, b.scenario.scenarioRevenue);
});

test('23 · the scenario discount replaces, and does not stack on, the historical one', () => {
  const rows = [row({ Name: '#912351', 'Lineitem sku': 'QCC-CX-HYSDT-PNS',
                      Vendor: 'CC', 'Lineitem price': '45.00',
                      'Lineitem discount': '4.50', Shipping: '0',
                      Subtotal: '40.50', Total: '40.50' })];
  const lines = calc(rows);
  near(lines[0].lineRevenue, 40.5);
  const s = summarizeScenario(lines, { sitewideDiscount: 0.20, adRate: 0, monthlyLabor: 0 });
  near(s.scenario.scenarioRevenue, 36);
  assert.notEqual(Math.round(s.scenario.scenarioRevenue * 100), Math.round(40.5 * 0.8 * 100));
});

test('24 · resolveEffectiveDiscount replaces rather than stacks', () => {
  assert.equal(resolveEffectiveDiscount('CC', 0.10,
    { 'CC': 0.17 }), 0.17);
  assert.equal(resolveEffectiveDiscount('LG', 0.10,
    { 'CC': 0.17 }), 0.10);
  assert.equal(resolveEffectiveDiscount('LG', 0.10, { 'LG': 0 }), 0);
  assert.equal(resolveEffectiveDiscount('', 0.10, {}), 0.10);
});

test('gross profit never silently includes advertising or labor', () => {
  const lines = calc(baseOrders(), { ship: SS });
  const s = summarizeScenario(lines, { sitewideDiscount: 0.08, adRate: 0.15, monthlyLabor: 7300,
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
  const rows = [row({ Name: '#912410', 'Lineitem sku': 'QCC-CX-HYSDT-PNS',
                      Vendor: 'CC', 'Lineitem price': '45.00',
                      Subtotal: '45', Total: '0', 'Discount Code': 'sample' })];
  const lines = calc(rows);
  const s = summarizeScenario(lines, { sitewideDiscount: 0.08, adRate: 0.15, monthlyLabor: 0 });
  assert.equal(s.scenario.totalRevenue, 0);
  assert.equal(s.scenario.operatingMargin, null);
});

test('shipping collected and expense stay at historical actuals in a scenario', () => {
  const lines = calc(baseOrders(), { ship: SS });
  const a = summarizeScenario(lines, { sitewideDiscount: 0, adRate: 0, monthlyLabor: 0 });
  const b = summarizeScenario(lines, { sitewideDiscount: 0.45, adRate: 0, monthlyLabor: 0 });
  assert.equal(a.scenario.shipCollected, b.scenario.shipCollected);
  assert.equal(a.scenario.shipExpense, b.scenario.shipExpense);
  near(a.scenario.shipExpense, 7.5 + 11 + 15);
  const legacy = summarizeScenario(calc(baseOrders(), { ship: SS, options: { shippingRules: 'legacy' } }), { sitewideDiscount: 0, adRate: 0, monthlyLabor: 0 });
  near(legacy.scenario.shipExpense, 7.5 + 11 + 14);
});

test('vendor costs are resolved per vendor and never borrowed across vendors', () => {
  const rows = [row({ Name: '#912420', 'Lineitem sku': 'QCC-CX-HYSDT-PNS',
                      Vendor: 'SA', 'Lineitem name': 'Not a real pairing',
                      'Lineitem price': '45.00', Subtotal: '45', Total: '45' })];
  const lines = calc(rows);
  assert.equal(lines[0].unitCost, null, 'no cost from another vendor');
  assert.equal(lines[0].missingCost, true);
});

test('a vendor SKU containing "+" is one product', () => {
  const rows = [row({ Name: '#912430', 'Lineitem sku': 'QSA-KRZDBMAY-XKRMLGP+DONKEY',
                      Vendor: 'SA',
                      'Lineitem name': 'Item G + add-on',
                      'Lineitem price': '38.00', Subtotal: '38', Total: '38' })];
  const lines = calc(rows);
  assert.equal(lines[0].unitCost, 19.0);
  assert.equal(lines[0].costSource, 'SA sheet');
  assert.equal(lines[0].missingCost, false);
});

test('a composite SKU sums both parts', () => {
  const lines = calculate(
    [row({ Name: '#912431', 'Lineitem sku': 'K4DP5262+VAPO6710', Vendor: 'House',
           'Lineitem name': 'Item + add-on', 'Lineitem price': '30.00',
           Subtotal: '30', Total: '30' })],
    new Map(), { 'K4DP5262': 6.0, 'VAPO6710': 2.0 }, {}, {}, {}, {}, {}, null, {},
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
  const line = { sku: 'QCC-Q', vendor: 'CC', qty: 2, unitPrice: 10,
                 baseMerchRevenue: 20, lineRevenue: 18, lineCogs: 9 };
  const snapshot = JSON.stringify(line);
  const out = calculateScenarioLine(line, { sitewideDiscount: 0.5 });
  assert.equal(JSON.stringify(line), snapshot);
  assert.equal(isDiscountEligible(line), true);
  near(out.scenarioRevenue, 10);
});

test('an "x" followed by digits inside a SKU is not a multipack', () => {
  const lines = calculate(
    [row({ Name: '#915400', 'Lineitem sku': 'K2Rx4417', Vendor: 'Seed Valley Farm',
           'Lineitem name': 'Item H - 2 inch', 'Lineitem price': '6.80',
           Subtotal: '6.80', Total: '6.80' })],
    new Map(), {}, {}, {}, {}, {}, {}, null, {}, null, null, {});
  assert.equal(lines[0].unitCost, privateRules().tierCosts['2inch'], 'plain tier');
  assert.equal(lines[0].costSource, 'MCG tier (2")');
});

test('a multipack SKU multiplies the tier', () => {
  const lines = calculate(
    [row({ Name: '#915401', 'Lineitem sku': 'K2ZX0942x3', Vendor: 'House',
           'Lineitem name': 'Item E 3-pack', 'Lineitem price': '21.60',
           Subtotal: '21.60', Total: '21.60' })],
    new Map(), {}, {}, {}, {}, {}, {}, null, {}, null, null, {});
  const { tierCosts, volumeDiscountTiers } = privateRules();
  const disc = volumeDiscountTiers.find(t => 3 >= t.min).disc;
  assert.equal(lines[0].unitCost, Math.round((tierCosts['2inch'] * 3 - disc * 3) * 100) / 100);
  assert.match(lines[0].costSource, /×3/);
  assert.match(lines[0].costSource, /vol disc, 3 plants/);
});

test('parseCSV keeps records whose quoted fields contain newlines intact', () => {
  const csv = [
    'Name,Lineitem sku,Notes,Vendor,Lineitem discount',
    '#1,SKU-A,"line one',
    'line two",CC,1.50',
    '#2,SKU-B,plain,SA,0',
  ].join('\n');
  const rows = parseCSV(csv);
  assert.equal(rows.length, 2, 'one row');
  assert.equal(rows[0].Notes, 'line one\nline two');
  assert.equal(rows[0].Vendor, 'CC');
  assert.equal(rows[0]['Lineitem discount'], '1.50');
  assert.equal(rows[1].Vendor, 'SA');
});

test('a zero-revenue subscription delivery is kept in its own channel', () => {
  const lines = calc([
    row({ Name: '#480001', 'Lineitem sku': 'SUB2-2-6', Vendor: 'House',
          'Lineitem name': '2 items/month - 6 month Subscription',
          'Lineitem price': '120.00', Subtotal: '120', Total: '120', Source: 'web' }),
    row({ Name: '#480002', 'Lineitem sku': 'SUB2-2-6', Vendor: 'House',
          'Lineitem name': '2 items/month - 6 month Subscription',
          'Lineitem price': '0.00', Subtotal: '0', Total: '0', Source: '294517' }),
    row({ Name: '#480003', 'Lineitem sku': 'QCC-CX-HYSDT-PNS', Vendor: 'CC',
          'Lineitem name': 'Item A', 'Lineitem price': '45.00',
          Subtotal: '45', Total: '45', Source: '294517' }),
  ]);
  const paid = lines.find(l => l.orderNum === '#480001');
  const leg  = lines.find(l => l.orderNum === '#480002');
  const sale = lines.find(l => l.orderNum === '#480003');

  assert.equal(paid.isSubRenewal, false, 'paying order');
  assert.equal(leg.isSubRenewal, true);
  assert.ok(leg.lineCogs > 0, 'COGS kept');
  assert.equal(leg.lineRevenue, 0, 'no revenue');
  assert.equal(sale.isSubRenewal, false);

  const s = summarize(lines);
  assert.equal(s.byChannel['294517'].revenue, 45);
  assert.ok(s.byChannel['294517'].gp > 0, 'channel GP positive');
  assert.ok(s.byChannel[SUB_RENEWAL_CHANNEL], 'own bucket');
  assert.equal(s.byChannel[SUB_RENEWAL_CHANNEL].revenue, 0);
  assert.ok(s.byChannel[SUB_RENEWAL_CHANNEL].gp < 0, 'cost only');
});

test('separating renewals changes no total', () => {
  const rows = [
    row({ Name: '#480010', 'Lineitem sku': 'SUB2-2-6', Vendor: 'House',
          'Lineitem name': 'sub', 'Lineitem price': '120.00', Subtotal: '120', Total: '120' }),
    row({ Name: '#480011', 'Lineitem sku': 'SUB2-2-6', Vendor: 'House',
          'Lineitem name': 'sub', 'Lineitem price': '0.00', Subtotal: '0', Total: '0' }),
  ];
  const s = summarize(calc(rows));
  const channelRev = Object.values(s.byChannel).reduce((a, v) => a + v.revenue, 0);
  const channelGp  = Object.values(s.byChannel).reduce((a, v) => a + v.gp, 0);
  near(channelRev, s.productRevenue);
  near(channelGp, s.productRevenue - s.totalCogs);
});

test('vendor costs resolve by vendor column and by SKU prefix', () => {
  const lines = calc([
    row({ Name: '#480100', 'Lineitem sku': 'QLM-TVWZ-VMS-ALD-DRFKXGH', Vendor: 'LM',
          'Lineitem name': 'Item F', 'Lineitem price': '39.60',
          Subtotal: '39.60', Total: '39.60' }),
    row({ Name: '#480101', 'Lineitem sku': 'QLM-TVWZ-VMS-ALD-DRFKXGH', Vendor: '',
          'Lineitem name': 'Item F', 'Lineitem price': '39.60',
          Subtotal: '39.60', Total: '39.60' }),
    row({ Name: '#480102', 'Lineitem sku': 'QLM-TVWZ-VMS-ALD-DRFKXGH', Vendor: 'LM',
          'Lineitem name': 'Item F', 'Lineitem price': '39.60',
          Subtotal: '39.60', Total: '39.60' }),
  ]);
  for (const l of lines) {
    assert.equal(l.unitCost, 19.8);
    assert.equal(l.vendorKey, 'LM');
    assert.equal(l.costSource, 'LM sheet');
    assert.equal(l.missingCost, false);
  }
});

test('a SKU never picks up another vendor\'s cost', () => {
  const lines = calc([
    row({ Name: '#480103', 'Lineitem sku': 'QLM-TVWZ-VMS-ALD-DRFKXGH',
          Vendor: 'CC', 'Lineitem name': 'Not a real pairing',
          'Lineitem price': '39.60', Subtotal: '39.60', Total: '39.60' }),
  ]);
  assert.equal(lines[0].unitCost, null);
  assert.equal(lines[0].missingCost, true);
});

test('a vendor rate and vendor rows work for every vendor', () => {
  const lines = calc([
    row({ Name: '#480104', 'Lineitem sku': 'QLM-TVWZ-VMS-ALD-DRFKXGH', Vendor: 'LM',
          'Lineitem name': 'Item F', 'Lineitem price': '40.00',
          Shipping: '6.00', Subtotal: '40', Total: '46' }),
    row({ Name: '#480105', 'Lineitem sku': 'QCC-CX-HYSDT-PNS', Vendor: 'CC',
          'Lineitem name': 'Item A', 'Lineitem price': '45.00',
          Shipping: '9.00', Subtotal: '45', Total: '54' }),
  ], { ship: new Map([['480104', 5], ['480105', 7]]) });

  const s = summarizeScenario(lines, {
    sitewideDiscount: 0.08, adRate: 0.15, monthlyLabor: 0, targetMargin: 0.16,
    vendorDiscounts: { 'LM': 0.25 } });

  const lm = s.byVendor.find(v => v.vendor === 'LM');
  const cc = s.byVendor.find(v => v.vendor === 'CC');
  assert.ok(lm, 'own vendor row');
  near(lm.scenarioRevenue, 30);
  near(cc.scenarioRevenue, 41.4);
  near(lm.cogs, 19.8);
  assert.ok(lm.maxCogs !== undefined, 'vendor max cost');
  for (const c of s.reconciliation.checks) assert.ok(c.ok, c.label);
});

test('labor with no product lines is reported unallocated', async () => {
  const { summarizeScenario } = await import('../shared/scenario.js');
  const a = { monthlyLabor: 7300, dateFrom: '2026-09-01', dateTo: '2026-09-30' };
  const none = summarizeScenario([], a);
  assert.deepEqual([none.reconciliation.ok, none.current.labor, none.scenario.labor, none.labor.unallocated, none.labor.method], [true, 0, 0, 7300, 'no_product_lines']);
  const passOnly = summarizeScenario([{ orderNum: '#1', sku: 'FEE', isRoute: true, lineRevenue: 0.98, qty: 1, lineCogs: 0.98, shipCollected: 0, shipPaid: 0 }], a);
  assert.equal(passOnly.reconciliation.ok, true, passOnly.reconciliation.checks.filter(c => !c.ok).map(c => `${c.label} ${c.diff}`).join('; '));
});
