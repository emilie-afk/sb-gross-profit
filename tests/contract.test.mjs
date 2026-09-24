/**
 * Revision 5 contract tests: discount/refund allocation, Route pass-through,
 * the metric dictionary, profitability completeness states, the publication
 * gate and the cost-catalog guard. Synthetic fixtures only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from '../shared/snapshot.js';
import { csvRowsToNormalizedOrders } from '../shared/adapters/legacy.js';
import { normalizeShopifyOrders } from '../shared/adapters/shopifyGraphql.js';
import { normalizeShipStationRows } from '../shared/adapters/shipstation.js';
import { normalizeHpdRows } from '../shared/adapters/hpd.js';
import { evaluateGate, canPublish, DEFAULT_SETTINGS } from '../shared/gate.js';
import { validateCatalog, catalogRevOf } from '../shared/catalog.js';
import { PROFITABILITY_STATUS, profitabilityStatus } from '../shared/metrics.js';
import { csvOrder, gqlOrder, ssCustom, FIXTURE_CATALOG } from './fixtures-normalized.mjs';

const ROUTE = { sku: 'ROUTEINS', name: 'Shipping Protection by Route - 0.98', vendor: 'Route', price: 0.98 };
const snap = (orders, shipRows = [], hpd = []) => buildSnapshot({
  weekStart: '2026-09-14', orders,
  shipments: shipRows.length ? normalizeShipStationRows(shipRows).shipments : [],
  hpdOrders: hpd, catalog: FIXTURE_CATALOG,
});
const csv = (...orders) => csvRowsToNormalizedOrders(orders.flat());
const line = (s, order, sku) => s.lines.find(l => l.orderName === order && l.sku === sku);
const blocking = s => s.reconciliation.filter(c => !c.passed && c.blocking);

// ─── Allocation contract ──────────────────────────────────────────────────────

test('historical CSV: a proven order-level discount is allocated across product lines only', () => {
  // gross 20 + 10 + 0.98 = 30.98; Subtotal 27.98 → residual 3.00, proven by Discount Amount 3.00
  const s = snap(csv(csvOrder({ name: '#1', subtotal: 27.98, shipping: 5, total: 32.98, discountAmount: 3, lines: [
    { sku: 'MG-ALOE', price: 10, qty: 2, vendor: 'Succulents Box' }, { sku: 'MG-JADE', price: 10, vendor: 'Succulents Box' }, ROUTE] })),
    ssCustom({ order: '1', fee: '5.00' }));
  const aloe = line(s, '#1', 'MG-ALOE'), jade = line(s, '#1', 'MG-JADE'), route = line(s, '#1', 'ROUTEINS');
  assert.deepEqual([aloe.discountAllocated, jade.discountAllocated, route.discountAllocated], [2, 1, 0]);
  assert.equal(aloe.discountSource, 'historical_residual_allocation');
  assert.deepEqual([aloe.contractRevenue, jade.contractRevenue], [18, 9]);
  assert.equal(route.routeCollected, 0.98);
  assert.deepEqual(blocking(s), []);
  assert.equal(s.revenueBridge.unexplainedResidual, 0);
});

test('an unproven residual is left visible, never forced through an invented allocation', () => {
  // residual 3.00 but Discount Amount only 1.00: not proven
  const s = snap(csv(csvOrder({ name: '#2', subtotal: 27, total: 27, discountAmount: 1, lines: [
    { sku: 'MG-ALOE', price: 30, vendor: 'Succulents Box' }] })));
  assert.equal(line(s, '#2', 'MG-ALOE').discountAllocated, 0);
  assert.deepEqual(s.issues.unallocatedResiduals, [{ orderName: '#2', residual: 3, classification: 'unproven' }]);
  assert.equal(s.revenueBridge.components.orderLevelResidualUnproven, 3);
  assert.equal(s.revenueBridge.unexplainedResidual, 0);
});

test('historical refunds are prorated over product lines only — never onto Route or gift cards', () => {
  const s = snap(csv(csvOrder({ name: '#3', subtotal: 40.98, total: 40.98, refunded: 6, lines: [
    { sku: 'MG-ALOE', price: 20, vendor: 'Succulents Box' }, { sku: 'MG-JADE', price: 10, vendor: 'Succulents Box' },
    { sku: 'GC10', price: 10, name: 'Gift Card - $10' }, ROUTE] })), ssCustom({ order: '3', fee: '4' }));
  assert.deepEqual([line(s, '#3', 'MG-ALOE').refundAllocated, line(s, '#3', 'MG-JADE').refundAllocated], [4, 2]);
  assert.equal(line(s, '#3', 'GC10').refundAllocated, 0);
  assert.equal(line(s, '#3', 'ROUTEINS').refundAllocated, 0);
  assert.equal(line(s, '#3', 'MG-ALOE').refundSource, 'historical_prorated_refund');
  assert.equal(s.totals.routeCollected, 0.98);
});

test('a refund larger than product revenue keeps the excess at order level', () => {
  const s = snap(csv(csvOrder({ name: '#4', subtotal: 10, shipping: 5, total: 15, refunded: 15, lines: [
    { sku: 'MG-ALOE', price: 10, vendor: 'Succulents Box' }] })), ssCustom({ order: '4', fee: '4' }));
  assert.equal(line(s, '#4', 'MG-ALOE').contractRevenue, 0);
  assert.deepEqual(blocking(s), []);
});

test('GraphQL: Shopify allocations and refund lines are used exactly as recorded', () => {
  const orders = normalizeShopifyOrders([gqlOrder({ name: '#5', subtotal: 27, shipping: 5, total: 32, discounts: 3, refunded: 9,
    lines: [{ sku: 'MG-ALOE', price: 20, allocations: [{ amount: 2 }], vendor: 'Succulents Box' },
            { sku: 'MG-JADE', price: 10, allocations: [{ amount: 1 }], vendor: 'Succulents Box' }],
    refunds: [{ amount: 9, lines: [{ lineIndex: 1, subtotal: 9 }] }] })]);
  const s = snap(orders, ssCustom({ order: '5', fee: '4' }));
  const aloe = line(s, '#5', 'MG-ALOE'), jade = line(s, '#5', 'MG-JADE');
  assert.deepEqual([aloe.discountSource, aloe.discountAllocated, aloe.contractRevenue], ['shopify_line_allocation', 0, 18]);
  assert.deepEqual([jade.refundSource, jade.refundAllocated, jade.contractRevenue], ['shopify_refund_line', 9, 0]);
  assert.equal(aloe.refundAllocated, 0);                      // not prorated: Shopify named the line
});

test('GraphQL and CSV give the same contract revenue for the same proportional order-level discount', () => {
  const g = snap(normalizeShopifyOrders([gqlOrder({ name: '#6', subtotal: 27, total: 27, discounts: 3, lines: [
    { sku: 'MG-ALOE', price: 20, allocations: [{ amount: 2 }], vendor: 'Succulents Box' },
    { sku: 'MG-JADE', price: 10, allocations: [{ amount: 1 }], vendor: 'Succulents Box' }] })]));
  const c = snap(csv(csvOrder({ name: '#6', subtotal: 27, total: 27, discountAmount: 3, lines: [
    { sku: 'MG-ALOE', price: 20, vendor: 'Succulents Box' }, { sku: 'MG-JADE', price: 10, vendor: 'Succulents Box' }] })));
  assert.deepEqual(g.lines.map(l => l.contractRevenue), c.lines.map(l => l.contractRevenue));
  assert.equal(g.totals.knownCostProductRevenue, c.totals.knownCostProductRevenue);
});

test('influencer sample orders are not double counted in the bridge or reported as unallocated', () => {
  const s = snap(csv(csvOrder({ name: '#7', subtotal: 0, shipping: 0, total: 0, discountAmount: 30, tags: 'influencer', lines: [
    { sku: 'MG-ALOE', price: 30, vendor: 'Succulents Box' }] })));
  assert.deepEqual(s.issues.unallocatedResiduals, []);
  assert.equal(s.revenueBridge.unexplainedResidual, 0);
});

// ─── Route (A40–A44, A48–A53) ─────────────────────────────────────────────────

test('A40/A53: a Route line has zero contribution and is detected by SKU or name', () => {
  const s = snap(csv(csvOrder({ name: '#10', subtotal: 10.98, shipping: 5, total: 15.98, lines: [
    { sku: 'MG-ALOE', price: 10, vendor: 'Succulents Box' }, ROUTE] }),
    csvOrder({ name: '#11', subtotal: 10.98, total: 10.98, lines: [
    { sku: 'MG-ALOE', price: 10, vendor: 'Succulents Box' }, { sku: 'RT-OTHER', price: 0.98, name: 'Shipping Protection by Route - 0.98' }] })),
    [...ssCustom({ shipment: 'S1', order: '10', fee: '5' }), ...ssCustom({ shipment: 'S2', order: '11', fee: '5' })]);
  assert.equal(s.totals.routeCollected, 1.96);
  assert.equal(s.totals.routeRemitted, 1.96);
  assert.equal(s.totals.routeNet, 0);
  assert.equal(s.totals.operatingRevenue, s.totals.shopifyNetRevenueInclPassThrough - 1.96);
});

test('A41/A42: Route with quantity 3 and a line discount remits its net, never unitPrice × qty', () => {
  const s = snap(csv(csvOrder({ name: '#12', subtotal: 12.44, total: 12.44, lines: [
    { sku: 'MG-ALOE', price: 10, vendor: 'Succulents Box' }, { ...ROUTE, qty: 3, discount: 0.5 }] })));
  const r = line(s, '#12', 'ROUTEINS');
  assert.equal(r.routeCollected, 2.44);
  assert.equal(r.routeRemitted, 2.44);
  assert.equal(s.totals.routeNet, 0);
});

test('A43/A44: Route refunds come only from Shopify refund lines; a full Route refund nets to zero', () => {
  const orders = normalizeShopifyOrders([gqlOrder({ name: '#13', subtotal: 10.98, total: 10.98, refunded: 0.98,
    lines: [{ sku: 'MG-ALOE', price: 10, vendor: 'Succulents Box' }, { sku: 'ROUTEINS', name: ROUTE.name, price: 0.98, vendor: 'Route' }],
    refunds: [{ amount: 0.98, lines: [{ lineIndex: 1, subtotal: 0.98 }] }] })]);
  const s = snap(orders);
  const r = line(s, '#13', 'ROUTEINS');
  assert.deepEqual([r.routeCollected, r.routeRemitted], [0, 0]);
  assert.equal(line(s, '#13', 'MG-ALOE').refundAllocated, 0);
  assert.equal(s.totals.routeNet, 0);
});

test('A48/A49/A50: Route is never in product, vendor, SKU, channel or missing-cost measures', () => {
  const s = snap(csv(csvOrder({ name: '#14', subtotal: 10.98, total: 10.98, lines: [
    { sku: 'NOPE-1', price: 10, vendor: 'Nobody' }, ROUTE] })));
  for (const dim of ['vendor', 'sku', 'channel', 'store']) {
    assert.ok(!s.breakdowns[dim].some(b => /route/i.test(b.key)), dim);
  }
  assert.ok(!s.issues.missingCost.some(m => m.sku === 'ROUTEINS'));
  assert.equal(s.lines.find(l => l.sku === 'ROUTEINS').flags.isProductLine, false);
});

test('A51: Route reconciliation runs on every snapshot and blocks publication when non-zero', () => {
  const s = snap(csv(csvOrder({ name: '#15', subtotal: 10.98, total: 10.98, lines: [{ sku: 'MG-ALOE', price: 10, vendor: 'Succulents Box' }, ROUTE] })));
  assert.ok(s.reconciliation.find(c => c.check === 'route_net_zero').passed);
  const broken = { ...s.totals, routeNet: 0.98 };
  const g = evaluateGate({ totals: broken, reconciliation: s.reconciliation, sources: { shopify: 'ok', shipstation: 'ok', hpd: 'ok' },
                           catalog: CURRENT_CATALOG, settings: LOCKED });
  assert.ok(g.failures.some(f => f.code === 'route_net'));
});

test('A52: operating vs current-compatible revenue — GP dollars identical, only the margin differs', () => {
  const s = snap(csv(csvOrder({ name: '#16', subtotal: 20.98, shipping: 5, total: 25.98, lines: [
    { sku: 'MG-ALOE', price: 10, qty: 2, vendor: 'Succulents Box' }, ROUTE] })), ssCustom({ order: '16', fee: '4' }));
  const t = s.totals;
  const currentCompatibleGp = t.shopifyNetRevenueInclPassThrough - t.knownProductCogs - t.routeRemitted - t.shippingExpense;
  assert.equal(Math.round(currentCompatibleGp * 100) / 100, t.operatingGpAfterShipping);
  assert.notEqual(t.operatingGpAfterShipping / t.shopifyNetRevenueInclPassThrough, t.operatingGpAfterShipping / t.operatingRevenue);
});

// ─── Metrics, completeness and labels ─────────────────────────────────────────

test('known-cost product GP excludes missing-cost lines and never treats missing cost as zero', () => {
  const s = snap(csv(csvOrder({ name: '#20', subtotal: 50, shipping: 5, total: 55, lines: [
    { sku: 'MG-ALOE', price: 20, vendor: 'Succulents Box' }, { sku: 'NOPE-1', price: 30, vendor: 'Nobody' }] })),
    ssCustom({ order: '20', fee: '5' }));
  const t = s.totals;
  assert.deepEqual([t.knownCostProductRevenue, t.knownProductCogs, t.knownCostProductGp], [20, 4.5, 15.5]);
  assert.deepEqual([t.missingCostRevenue, t.missingCostUnits, t.missingCostLines], [30, 1, 1]);
  assert.equal(t.costCoverageByRevenue, 40);
  assert.equal(t.costCoverageByUnits, 50);
  assert.equal(t.labels.productGp, 'Known-cost product GP');
  assert.equal(t.labels.costCoverage, 'Incomplete cost coverage');
  assert.equal(t.profitabilityStatus, 'provisional_missing_costs');
  assert.equal(t.labels.headline, 'Provisional operating GP after shipping');
  assert.match(t.labels.notes[0], /^Excludes unknown COGS on \$30\.00 of product revenue/);
  const v = s.breakdowns.vendor.find(b => b.key === 'Nobody');
  assert.deepEqual([v.coverageStatus, v.gpLabel, v.coverageLabel], ['incomplete', 'Known-cost product GP', 'Incomplete cost coverage']);
});

test('all four profitability states and their labels', () => {
  assert.equal(profitabilityStatus(true, true), PROFITABILITY_STATUS.COMPLETE);
  assert.equal(profitabilityStatus(false, true), 'provisional_missing_costs');
  assert.equal(profitabilityStatus(true, false), 'provisional_missing_shipping');
  assert.equal(profitabilityStatus(false, false), 'provisional_missing_costs_and_shipping');

  const complete = snap(csv(csvOrder({ name: '#21', subtotal: 20, shipping: 5, total: 25, lines: [{ sku: 'MG-ALOE', price: 20, vendor: 'Succulents Box' }] })),
    ssCustom({ order: '21', fee: '5' }));
  assert.equal(complete.totals.profitabilityStatus, 'complete');
  assert.equal(complete.totals.labels.headline, 'Operating GP after shipping');
  assert.equal(complete.totals.labels.productGp, 'Product GP');
  assert.ok(!/provisional/i.test(complete.narrative.headline));

  const noShip = snap(csv(csvOrder({ name: '#22', subtotal: 20, shipping: 5, total: 25, lines: [{ sku: 'MG-ALOE', price: 20, vendor: 'Succulents Box' }] })));
  assert.equal(noShip.totals.profitabilityStatus, 'provisional_missing_shipping');
  assert.match(noShip.narrative.headline, /^Provisional operating GP after shipping/);
  assert.match(noShip.totals.labels.notes.join(' '), /Excludes shipping expense on 1 order/);
});

test('A39: taxes are excluded from revenue and from both GP measures', () => {
  const s = snap(csv(csvOrder({ name: '#23', subtotal: 20, shipping: 5, taxes: 1.8, total: 26.8, lines: [{ sku: 'MG-ALOE', price: 20, vendor: 'Succulents Box' }] })),
    ssCustom({ order: '23', fee: '5' }));
  assert.equal(s.totals.operatingRevenue, 25);
  assert.equal(s.totals.operatingGpAfterShipping, 25 - 4.5 - 5);
  assert.equal(s.totals.knownCostProductGp, 15.5);
});

// ─── Shipping coverage (A29–A35) ──────────────────────────────────────────────

test('A29/A34: Pure HP Dropship and ship-nothing orders are excluded from ShipStation coverage', () => {
  const s = snap(csv(
    csvOrder({ name: '#30', subtotal: 20, shipping: 8, total: 28, lines: [{ sku: 'FH-POTHOS', price: 20, vendor: 'House Plant Dropship' }] }),
    csvOrder({ name: '#31', subtotal: 5, total: 5, lines: [{ sku: 'PRINT-1', price: 5, name: 'Printable: Notepad', requiresShipping: false }] }),
    csvOrder({ name: '#32', subtotal: 20, shipping: 5, total: 25, lines: [{ sku: 'MG-ALOE', price: 20, vendor: 'Succulents Box' }] })),
    ssCustom({ order: '32', fee: '5' }));
  assert.equal(s.totals.ordersRequiringShipStationRate, 1);
  assert.equal(s.totals.ordersWithValidShipStationRate, 1);
  const hpd = s.orders.find(o => o.orderName === '#30');
  assert.deepEqual([hpd.requiresShipStationRate, hpd.shippingExpenseSource, hpd.shippingExpenseStatus], [false, 'hpd_pass_through', 'pass_through']);
  assert.equal(s.orders.find(o => o.orderName === '#31').shippingExpenseSource, 'no_shipment_required');
});

test('A30/A60: a zero-cost non-HPD shipment is a visible missing-expense issue', () => {
  const s = snap(csv(csvOrder({ name: '#33', subtotal: 20, shipping: 5, total: 25, lines: [{ sku: 'MG-ALOE', price: 20, vendor: 'Succulents Box' }] })),
    ssCustom({ order: '33', fee: '0.00', rate: '0.00', paid: '5' }));
  assert.deepEqual(s.issues.missingShipping.map(i => [i.orderName, i.reason]), [['#33', 'zero_or_blank_cost']]);
  assert.equal(s.orders[0].shippingExpenseStatus, 'missing_shipstation_rate');
});

test('a split order with one priced and one unpriced label is still missing expense', () => {
  const s = snap(csv(csvOrder({ name: '#34', subtotal: 20, shipping: 5, total: 25, lines: [{ sku: 'MG-ALOE', price: 20, vendor: 'Succulents Box' }] })),
    [...ssCustom({ shipment: 'S1', order: '34', fee: '5' }), ...ssCustom({ shipment: 'S2', order: '34', fee: '0' })]);
  assert.equal(s.issues.missingShipping[0].reason, 'partial_shipment_cost');
});

// Revision 6: the gate needs a locked Carrier Fee priority and a verified-current catalog.
const LOCKED = { ...DEFAULT_SETTINGS, carrier_fee_priority_locked: true, store_timezone_confirmed: true };
const CURRENT_CATALOG = { accepted: true, rev: 'cat_x', freshness: { status: 'current' } };

test('A31/A32/A33: mixed 17381 + HPD keeps both legs; HPD actual wins over pass-through; no log is not a blocker', () => {
  const hpdCsv = [{ 'Date - Order Date': '2026-09-15', 'Order - Number': 'HPD-9', 'Carrier - Service Selected': 'USPS', 'Item - Qty': '1',
    'Item - SKU': 'FH-POTHOS', 'Notes - From Buyer': '#35', 'Actual Net Terms Cost (Labor + Carrier Shipping)': '7.10',
    'Prepaid Fixed Price': '6', 'Cost Difference (Net Terms - Prepaid)': '1.10' }];
  const orders = () => csv(csvOrder({ name: '#35', subtotal: 40, shipping: 12, total: 52, lines: [
    { sku: 'MG-ALOE', price: 20, vendor: 'Succulents Box' }, { sku: 'FH-POTHOS', price: 20, vendor: 'House Plant Dropship' }] }));
  const withLog = snap(orders(), ssCustom({ order: '35', fee: '4' }), normalizeHpdRows(hpdCsv));
  const o = withLog.orders[0];
  assert.deepEqual([o.shipPaidSS, o.shipPaidHP, o.shippingExpenseSource], [4, 7.1, 'mixed_shipstation_plus_hpd_actual']);
  const noLog = snap(orders(), ssCustom({ order: '35', fee: '4' }));
  assert.deepEqual([noLog.orders[0].shipPaidHP, noLog.orders[0].shippingExpenseSource], [8, 'mixed_shipstation_plus_hpd_pass_through']);
  const g = evaluateGate({ totals: noLog.totals, reconciliation: noLog.reconciliation,
    sources: { shopify: 'ok', shipstation: 'ok', hpd: 'pending' }, catalog: CURRENT_CATALOG, settings: LOCKED });
  assert.ok(g.passed);
  assert.ok(g.warnings.some(w => w.code === 'source_hpd'));
  assert.ok(g.warnings.some(w => w.code === 'hpd_pass_through_assumed'));
  assert.notEqual(noLog.totals.profitabilityStatus, 'complete');           // assumed pass-through is never "complete"
  assert.equal(noLog.orders[0].hpdShippingBasis, 'hpd_pass_through_assumed');
  assert.equal(withLog.orders[0].hpdShippingBasis, 'hpd_actual');
});

test('A35: coverage at or above the threshold publishes with every missing order listed', () => {
  const orders = [], ship = [];
  for (let i = 0; i < 20; i++) {
    orders.push(csvOrder({ name: `#4${i}`, subtotal: 20, shipping: 5, total: 25, lines: [{ sku: 'MG-ALOE', price: 20, vendor: 'Succulents Box' }] }));
    ship.push(...ssCustom({ shipment: `S${i}`, order: `4${i}`, fee: i === 0 ? '0' : '5' }));
  }
  const s = snap(csv(...orders), ship);
  assert.equal(s.totals.shipStationExpenseCoverage, 95);
  const g = evaluateGate({ totals: s.totals, reconciliation: s.reconciliation, sources: { shopify: 'ok', shipstation: 'ok', hpd: 'ok' },
                           catalog: CURRENT_CATALOG, settings: LOCKED });
  assert.ok(g.passed);
  assert.equal(s.issues.missingShipping.length, 1);
  const below = evaluateGate({ totals: { ...s.totals, ordersWithValidShipStationRate: 18 }, reconciliation: s.reconciliation,
    sources: { shopify: 'ok', shipstation: 'ok', hpd: 'ok' }, catalog: CURRENT_CATALOG, settings: LOCKED });
  assert.ok(below.failures.some(f => f.code === 'ss_coverage'));
});

test('publication stays off: a passing gate still cannot publish without both locks', () => {
  const gate = { passed: true };
  assert.equal(canPublish(gate, LOCKED, undefined).allowed, false);
  assert.equal(canPublish(gate, { ...LOCKED, publication_enabled: true }, undefined).reason, 'publication_not_allowed_in_environment');
  assert.equal(canPublish(gate, LOCKED, 'true').reason, 'publication_disabled');
  assert.equal(canPublish(gate, { ...LOCKED, publication_enabled: true }, 'true').allowed, true);
  assert.equal(canPublish({ passed: false }, { ...LOCKED, publication_enabled: true }, 'true').reason, 'gate_failed');
});

// ─── Cost catalog (A36, A37) ──────────────────────────────────────────────────

const vendorTable = counts => Object.fromEntries(Object.entries(counts).map(([v, n]) =>
  [v, Object.fromEntries(Array.from({ length: n }, (_, i) => [`${v}-${i}`, { unitCost: 1 }]))]));
const goodCatalog = () => ({ tables: { mcg_total: { A: 1 }, vendor_index: { x: {} }, vendor_costs: vendorTable(
  { 'Live to Give': 30, 'Lively Good': 171, 'Calathea Collective': 462, 'Surfside Arrangement': 11, 'LindaMakes': 396 }) } });

test('A36: an empty or failed catalog import is rejected', () => {
  assert.equal(validateCatalog({ tables: {} }).accepted, false);
  assert.ok(validateCatalog({ tables: {} }).reasons.some(r => /mcg_total/.test(r)));
  assert.equal(validateCatalog(goodCatalog()).accepted, true);
});

test('A37: a vendor catalog dropping from 462 to 300 SKUs is blocked pending review', () => {
  const c = goodCatalog();
  c.tables.vendor_costs['Calathea Collective'] = vendorTable({ 'Calathea Collective': 300 })['Calathea Collective'];
  const v = validateCatalog(c);
  assert.equal(v.accepted, false);
  assert.ok(v.reasons.some(r => /Calathea Collective: 300/.test(r)));
});

test('catalog versions are content-addressed: identical content, identical rev', async () => {
  assert.equal(await catalogRevOf(goodCatalog()), await catalogRevOf(goodCatalog()));
  const changed = goodCatalog(); changed.tables.mcg_total.B = 2;
  assert.notEqual(await catalogRevOf(changed), await catalogRevOf(goodCatalog()));
});
