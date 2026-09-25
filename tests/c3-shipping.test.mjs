/**
 * Revision 9 C3: Shipping Cost Report as the shipping expense source.
 * Engine rules, order-level classification, lifecycle, gates and the
 * local-only dashboard preview. Synthetic data only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate, summarize, cancelledAfterShippingEvidence, CANCELLED_AFTER_SHIPPING_CATEGORY } from '../shared/calculator.js';
import { classifyShipping, shippingLifecycle, publicationShippingStatus, shippingDisclosures, unmatchedReportOrders, revisedCategory,
         LIFECYCLE, EXPECTATION, ZERO_SHIPPING, COVERAGE_COMPLETE_LABEL, RESERVED_SHIPPING_COMPLETE, PUBLICATION_SHIPPING_STATUS, DEFAULT_POLICY_SETTINGS } from '../shared/shippingPolicy.js';
import { evaluateGate, canPublish, DEFAULT_SETTINGS } from '../shared/gate.js';
import { previewShippingCostReport, shippingCostReportKind } from '../shared/adapters/shippingCostReport.js';
import { SHOPIFY_ORDERS_CSV_COLUMNS } from '../shared/adapters/shopifyCsv.js';
import { row } from './fixtures.mjs';
import { reportRow } from './fixtures-shipping-cost.mjs';

const calc = (rows, ship = new Map(), options = {}) => calculate(rows, ship, {}, {}, {}, {}, {}, {}, null, {}, null, null, options);
const agg = entries => new Map(entries.map(([k, cents, n = 1, first = '2026-09-15', last = first]) => [k, { orderKey: k, costCents: cents, rowCount: n, firstShipDate: first, lastShipDate: last }]));
const classify = (rows, report = new Map(), settings = {}) => classifyShipping({ rows, lines: calc(rows, new Map([...report].map(([k, v]) => [k, v.costCents / 100]))), reportAgg: report, settings });
const orderOf = (c, name) => c.orders.find(o => o.orderName === name);

// ─── Engine: Lively Root pass-through ────────────────────────────────────────
test('Lively Root (Shopify Collective) shipping is passed through: expense = collected, net zero, ShipStation cost not used', () => {
  const rows = [row({ Name: '#991001', 'Lineitem sku': 'PL_FLF_4IN1', Vendor: 'Lively Root', 'Lineitem price': '67.08', Shipping: '15.00', Total: '82.08' }),
                row({ Name: '#991001', 'Lineitem sku': 'ROUTEINS', 'Lineitem name': 'Shipping Protection by Route', Vendor: 'Route', 'Lineitem price': '0.98', Shipping: '', Total: '' })];
  const lines = calc(rows, new Map([['991001', 9.00]]));
  const first = lines.find(l => l.orderCat);
  assert.deepEqual([first.shipCollected, first.shipPaid, first.shipPaidLR, first.shipPaidSS, first.shipDelta], [15, 15, 15, 0, 0]);
  assert.match(first.shipNote, /ShipStation cost present, not used/);
  assert.equal(summarize(lines).shipByVendor['Lively Root'].paid, 15);
  const legacy = calc(rows, new Map([['991001', 9.00]]), { shippingRules: 'legacy' }).find(l => l.orderCat);
  assert.equal(legacy.shipPaid, 9, 'legacy engine used the ShipStation cost');
  assert.equal(legacy.shipPaidLR, undefined);
});

test('a Lively Root line mixed with another shipped vendor is not split: the order keeps its ShipStation treatment', () => {
  const rows = [row({ Name: '#991002', 'Lineitem sku': 'PL_FLF_4IN1', Vendor: 'Lively Root', 'Lineitem price': '67.08', Shipping: '12.00', Total: '99.08' }),
                row({ Name: '#991002', 'Lineitem sku': 'S2KY2965', Vendor: 'Succulents Box', 'Lineitem price': '20.00', Shipping: '', Total: '' })];
  const first = calc(rows, new Map([['991002', 6.10]])).find(l => l.orderCat);
  assert.equal(first.orderCat, 'Pure 17381');
  assert.deepEqual([first.shipPaid, first.shipPaidLR], [6.10, null]);
});

// ─── Engine: cancelled after shipping ────────────────────────────────────────
const cancelledRow = over => row({ Name: '#991010', 'Lineitem sku': 'S2KY2965', Vendor: 'Succulents Box', 'Lineitem price': '20.00',
  Subtotal: '20.00', Shipping: '6.99', Total: '26.99', 'Refunded Amount': '20.00', 'Fulfillment Status': 'fulfilled',
  'Fulfilled at': '2026-09-15 09:00:00 -0700', 'Cancelled at': '2026-09-16 10:00:00 -0700', ...over });

test('cancelled after shipping, proven by event order: customer shipping and carrier cost are kept as a shipping-only result', () => {
  const lines = calc([cancelledRow()], new Map([['991010', 5.10]]));
  assert.equal(lines.length, 1);
  const l = lines[0];
  assert.deepEqual([l.orderCat, l.orderTotal, l.lineRevenue, l.lineCogs, l.shipCollected, l.shipPaid, l.isShippingOnly], [CANCELLED_AFTER_SHIPPING_CATEGORY, 6.99, 0, 0, 6.99, 5.1, true]);
  assert.equal(calc([cancelledRow()], new Map([['991010', 5.10]]), { shippingRules: 'legacy' }).length, 0, 'legacy engine drops the order');
});

test('the final cancellation flag alone never implies shipment: every evidence gap keeps the order excluded', () => {
  const cases = [
    [{ 'Fulfilled at': '' }, 'no_fulfilled_at'],
    [{ 'Fulfilled at': '2026-09-17 09:00:00 -0700' }, 'fulfilled_after_cancellation'],
    [{ 'Fulfillment Status': 'unfulfilled' }, 'not_fulfilled'],
    [{ 'Refunded Amount': '26.99' }, 'retained_amount_is_not_the_shipping'],
  ];
  for (const [over, reason] of cases) {
    assert.equal(cancelledAfterShippingEvidence(cancelledRow(over), 5.10).reason, reason);
    assert.equal(calc([cancelledRow(over)], new Map([['991010', 5.10]])).length, 0, reason);
  }
  assert.equal(cancelledAfterShippingEvidence(cancelledRow(), null).reason, 'no_carrier_cost');
});

test('zero-impact case: cancelled orders without shipment evidence change nothing', () => {
  const rows = [cancelledRow({ 'Fulfillment Status': '', 'Fulfilled at': '', 'Lineitem fulfillment status': 'pending' }),
                row({ Name: '#991011', 'Lineitem sku': 'S2KY2965', Vendor: 'Succulents Box', 'Lineitem price': '20', Shipping: '5', Total: '25' })];
  const a = summarize(calc(rows, new Map([['991011', 4]]))), b = summarize(calc(rows, new Map([['991011', 4]]), { shippingRules: 'legacy' }));
  assert.deepEqual([a.totalRevenue, a.totalCogs, a.totalShipCollected, a.totalShipPaid], [b.totalRevenue, b.totalCogs, b.totalShipCollected, b.totalShipPaid]);
  assert.equal(orderOf(classify(rows), '#991010').expectation, EXPECTATION.CANCELLED_BEFORE_FULFILLMENT);
});

test('Shopify "Fulfilled at" is an approved (non-personal) column', () => {
  assert.ok(SHOPIFY_ORDERS_CSV_COLUMNS.includes('Fulfilled at'));
});

// ─── Classification ──────────────────────────────────────────────────────────
test('order-level coverage: expected ShipStation orders matched to a Shipping Cost; exclusions carry a reason', () => {
  const rows = [
    row({ Name: '#992001', 'Lineitem sku': 'S2KY2965', Vendor: 'Succulents Box', 'Lineitem price': '20', Shipping: '5', Total: '25', 'Created at': '2026-09-15 10:00:00 -0700' }),
    row({ Name: '#992002', 'Lineitem sku': 'S2KY2966', Vendor: 'Succulents Box', 'Lineitem price': '20', Shipping: '5', Total: '25', 'Created at': '2026-09-15 10:00:00 -0700' }),
    row({ Name: '#992003', 'Lineitem sku': 'FH-POTHOS', Vendor: 'House Plant Dropship', 'Lineitem price': '30', Shipping: '9', Total: '39' }),
    row({ Name: '#992004', 'Lineitem sku': 'PL_FLF_4IN1', Vendor: 'Lively Root', 'Lineitem price': '60', Shipping: '15', Total: '75' }),
    row({ Name: '#992005', 'Lineitem sku': 'PRINTABLE-1', 'Lineitem name': 'Printable coloring book', 'Lineitem requires shipping': 'false', Vendor: 'Succulents Box', 'Lineitem price': '5', Total: '5' }),
    row({ Name: '#992006', 'Lineitem sku': '', 'Lineitem name': 'Expedite fee', 'Lineitem price': '3', Total: '3' }),
    row({ Name: '#992007', 'Lineitem sku': 'S2KY2967', Vendor: 'Succulents Box', 'Lineitem price': '20', Shipping: '5', Total: '25', 'Cancelled at': '2026-09-16 10:00:00 -0700', 'Fulfillment Status': 'fulfilled' }),
    row({ Name: '#992008', 'Lineitem sku': 'S2KY2968', Vendor: 'Succulents Box', 'Lineitem price': '20', Shipping: '5', Total: '25', 'Cancelled at': '2026-09-16 10:00:00 -0700', 'Lineitem fulfillment status': 'restocked' }),
  ];
  const c = classify(rows, agg([['992001', 510]]));
  assert.deepEqual([c.coverage.numerator, c.coverage.denominator, c.counts.expectedOrdersWithoutCost], [1, 2, 1]);
  assert.deepEqual(c.coverage.excluded, { [EXPECTATION.PURE_HPD]: 1, [EXPECTATION.COLLECTIVE]: 1, [EXPECTATION.NO_SHIPPING_REQUIRED]: 1,
    [EXPECTATION.NO_SKU_LINE]: 1, [EXPECTATION.CANCELLED_UNVERIFIED]: 1, [EXPECTATION.CANCELLED_BEFORE_FULFILLMENT]: 1 });
  assert.equal(c.counts.cancelledStatusUnverified, 1, 'a fulfilled-then-cancelled order without proof is never cleared');
});

test('$0 customer shipping: prepaid subscription, MCG $89 promotion (MCG products only), vendor legacy by cut-off, other, unknown', () => {
  const d = '2026-09-15 10:00:00 -0700';
  const rows = [
    row({ Name: '#993001', 'Lineitem sku': 'SUB2-1-3', Vendor: 'Succulents Box', 'Lineitem price': '0', Tags: 'Subscription Recurring Order', 'Created at': d }),
    row({ Name: '#993002', 'Lineitem sku': 'S2KY2965', Vendor: 'Succulents Box', 'Lineitem price': '30', 'Lineitem quantity': '3', 'Created at': d }),
    row({ Name: '#993003', 'Lineitem sku': 'S2KY2965', Vendor: 'Succulents Box', 'Lineitem price': '30', 'Lineitem quantity': '2', 'Created at': d }),
    row({ Name: '#993003', 'Lineitem sku': 'CC-WC-1', Vendor: 'Calathea Collective', 'Lineitem price': '50', 'Created at': d }),
    row({ Name: '#993004', 'Lineitem sku': 'AS-TILL', Vendor: 'Air Plant Shop', 'Lineitem price': '9', 'Created at': '2026-08-13 10:00:00 -0700' }),
    row({ Name: '#993005', 'Lineitem sku': 'AS-TILL', Vendor: 'Air Plant Shop', 'Lineitem price': '9', 'Created at': '2026-08-14 10:00:00 -0700' }),
    row({ Name: '#993006', 'Lineitem sku': 'S2KY1', Vendor: 'Succulents Box', 'Lineitem price': '10', Source: 'shopify_draft_order', 'Created at': d }),
    row({ Name: '#993007', 'Lineitem sku': 'S2KY2', Vendor: 'Succulents Box', 'Lineitem price': '10', 'Created at': d }),
  ];
  const c = classify(rows);
  const z = n => [orderOf(c, n).zeroShipping, orderOf(c, n).zeroShippingReason];
  assert.deepEqual(z('#993001'), [ZERO_SHIPPING.PREPAID_SUBSCRIPTION, null]);
  assert.deepEqual(z('#993002'), [ZERO_SHIPPING.PROMOTION, null], '$90 of MCG products');
  assert.deepEqual(z('#993003'), [ZERO_SHIPPING.UNKNOWN, null], '$60 MCG + $50 Calathea: the threshold counts MCG products only');
  assert.deepEqual(z('#993004'), [ZERO_SHIPPING.VENDOR_LEGACY, null], 'the day before Air Plant Shop\'s first paid-shipping date');
  assert.deepEqual(z('#993005'), [ZERO_SHIPPING.UNKNOWN, null], 'on the date the new treatment applies');
  assert.deepEqual(z('#993006'), [ZERO_SHIPPING.OTHER, 'draft']);
  assert.deepEqual(z('#993007'), [ZERO_SHIPPING.UNKNOWN, null]);
  assert.equal(orderOf(c, '#993004').shippingCategory, 'Pure Free Ship');
  assert.equal(orderOf(c, '#993005').shippingCategory, 'Pure Vendor (paid shipping)');
});

test('moving a vendor cut-off by one day is configuration, not code', () => {
  const rows = [row({ Name: '#993010', 'Lineitem sku': 'AS-TILL', Vendor: 'Air Plant Shop', 'Lineitem price': '9', 'Created at': '2026-08-14 10:00:00 -0700' })];
  assert.equal(orderOf(classify(rows), '#993010').zeroShipping, ZERO_SHIPPING.UNKNOWN);
  const later = { vendor_first_paid_shipping_dates: { ...DEFAULT_POLICY_SETTINGS.vendor_first_paid_shipping_dates, 'Air Plant Shop': '2026-08-15' } };
  assert.equal(orderOf(classify(rows, new Map(), later), '#993010').zeroShipping, ZERO_SHIPPING.VENDOR_LEGACY);
  assert.equal(revisedCategory('Mixed (HP + Free Ship)', false), 'Mixed (HP + Vendor)');
});

test('a Heat Pack delay needs Shopify evidence; the later cost stays on the original order', () => {
  const heat = [row({ Name: '#994001', 'Lineitem sku': 'SUB2-1-3', Vendor: 'Succulents Box', 'Lineitem price': '30', Shipping: '6.99', Total: '36.99' }),
                row({ Name: '#994001', 'Lineitem sku': 'HEATPACK', 'Lineitem name': 'Heat Pack (Subscription)', Vendor: 'Succulents Box', 'Lineitem price': '0', 'Lineitem fulfillment status': 'pending' })];
  const plain = [row({ Name: '#994002', 'Lineitem sku': 'S2KY2965', Vendor: 'Succulents Box', 'Lineitem price': '30', Shipping: '6.99', Total: '36.99' })];
  const report = agg([['994001', 1020, 2, '2026-09-01', '2026-09-24'], ['994002', 1020, 2, '2026-08-01', '2026-09-07']]);
  const c = classify([...heat, ...plain], report);
  assert.equal(orderOf(c, '#994001').multiShipment, 'heat_pack_delayed_shipment');
  assert.equal(orderOf(c, '#994002').multiShipment, 'multiple_shipments_reason_unverified', 'no Heat Pack evidence: reason unverified');
  const lines = calc([...heat, ...plain], new Map([['994001', 10.2], ['994002', 10.2]]));
  assert.equal(lines.find(l => l.orderNum === '#994001' && l.orderCat).shipPaid, 10.2, 'both labels are the original order\'s expense');
});

test('report orders with no Shopify order are counted by position, never matched by guess', () => {
  const u = unmatchedReportOrders(agg([['100001', 400], ['500000', 500], ['900009', 600], ['300000', 100]]), new Set(['300000', '400000', '600000']));
  assert.deepEqual([u.total, u.belowRange, u.insideRange, u.aboveRange, u.costCents], [3, 1, 1, 1, 1500]);
});

// ─── Lifecycle, publication status, disclosures ─────────────────────────────
test('lifecycle: open → updated → complete (all matched, or the 14-day aging limit); partial-shipment checks stay false', () => {
  const open = { numerator: 9, denominator: 10, expectedWithoutCost: 1 };
  const a = shippingLifecycle({ coverage: open, weekEnd: '2026-09-20', asOf: '2026-09-21T08:30:00Z' });
  assert.equal(a.status, LIFECYCLE.OPEN);
  assert.equal(a.agingEnds, '2026-10-04');
  assert.equal(shippingLifecycle({ coverage: open, weekEnd: '2026-09-20', asOf: '2026-09-28', previousShippingExpense: 10, shippingExpense: 12 }).status, LIFECYCLE.UPDATED);
  const aged = shippingLifecycle({ coverage: open, weekEnd: '2026-09-20', asOf: '2026-10-05T00:00:00Z' });
  assert.deepEqual([aged.status, aged.agedWithoutCost, aged.label], [LIFECYCLE.COMPLETE, 1, COVERAGE_COMPLETE_LABEL]);
  const full = shippingLifecycle({ coverage: { numerator: 10, denominator: 10, expectedWithoutCost: 0 }, weekEnd: '2026-09-20', asOf: '2026-09-21' });
  assert.equal(full.status, LIFECYCLE.COMPLETE);
  for (const l of [a, aged, full]) assert.deepEqual([l.partial_fulfillment_check_available, l.partial_fulfillment_verification_complete], [false, false]);
  assert.ok(![a, aged, full].some(l => l.status === RESERVED_SHIPPING_COMPLETE));
  assert.equal(COVERAGE_COMPLETE_LABEL, 'Order-level shipping coverage complete. Partial-shipment verification is unavailable.');
});

test('publication shipping status names; published_shipping_complete is unreachable without partial verification', () => {
  const P = PUBLICATION_SHIPPING_STATUS;
  assert.equal(publicationShippingStatus({ sourceVerified: false, provisionalEnabled: false, lifecycleStatus: LIFECYCLE.COMPLETE }), null);
  assert.equal(publicationShippingStatus({ sourceVerified: false, provisionalEnabled: true, lifecycleStatus: LIFECYCLE.OPEN }), P.PROVISIONAL);
  assert.equal(publicationShippingStatus({ sourceVerified: true, provisionalEnabled: false, lifecycleStatus: LIFECYCLE.COMPLETE }), P.ORDER_COVERAGE_COMPLETE);
  assert.deepEqual(Object.values(P), ['published_provisional_shipping', 'published_order_coverage_complete', 'published_shipping_complete']);
});

test('disclosures keep product-cost completeness and shipping-source verification as separate statuses', () => {
  const d = shippingDisclosures({ catalogRev: 'cat_910fdfcbc94775ba', missingCostLines: 81, missingCostRevenue: 4747.97, sourceVerified: false,
                                  lifecycle: { status: LIFECYCLE.OPEN } });
  assert.deepEqual([d.productCost.status, d.shippingSource.status, d.catalogVersion, d.publication], ['incomplete', 'unverified', 'cat_910fdfcbc94775ba', 'disabled']);
  assert.deepEqual(d.labels, ['Provisional', 'Shipping source unverified', 'Product-cost catalog incomplete', '81 lines missing product cost', 'Publication disabled']);
});

// ─── Gate ────────────────────────────────────────────────────────────────────
const okTotals = { routeNet: 0, ordersRequiringShipStationRate: 10, ordersWithValidShipStationRate: 10, missingCostLines: 0, hpdOrdersPassThrough: 0, insuranceDisclosed: 0, labels: { notes: [] } };
const baseGate = extra => evaluateGate({ totals: okTotals, reconciliation: [], sources: { shopify: 'ok', shipstation: 'ok', hpd: 'ok' },
  catalog: { accepted: true, rev: 'c', freshness: { status: 'current' } }, settings: { ...DEFAULT_SETTINGS, carrier_fee_priority_locked: true, store_timezone_confirmed: true, ...extra.settings },
  shippingC3: extra.c3 });

test('gate: an unverified Shipping Cost Report source and open coverage block; provisional publication would turn them into warnings', () => {
  const g = baseGate({ settings: {}, c3: { lifecycle: { status: LIFECYCLE.OPEN, label: 'open' }, publicationShippingStatus: null } });
  assert.deepEqual(g.failures.map(f => f.code).sort(), ['shipping_order_coverage_open', 'shipping_source_unverified']);
  assert.ok(g.warnings.some(w => w.code === 'partial_fulfillment_unverified'));
  const p = baseGate({ settings: { provisional_publication_enabled: true }, c3: { lifecycle: { status: LIFECYCLE.OPEN }, publicationShippingStatus: 'published_provisional_shipping' } });
  assert.equal(p.passed, true);
  assert.deepEqual(p.warnings.map(w => w.code).filter(c => c.startsWith('shipping')).sort(), ['shipping_order_coverage_open', 'shipping_source_unverified']);
  const verified = baseGate({ settings: { shipping_cost_report_source_verified: true }, c3: { lifecycle: { status: LIFECYCLE.COMPLETE } } });
  assert.equal(verified.passed, true);
  assert.equal(canPublish({ ...g, passed: true }, { ...DEFAULT_SETTINGS, carrier_fee_priority_locked: true, store_timezone_confirmed: true, publication_enabled: true }, 'true').reason,
               'shipping_source_unverified', 'current settings are re-checked at publication');
});

// ─── Local-only dashboard preview ────────────────────────────────────────────
test('the dashboard preview drops Recipient, Shipping Paid and +/- before anything else and sums Shipping Cost per order', () => {
  const raw = [reportRow({ date: '2026-09-15', order: '995001', cost: '4.10' }), reportRow({ date: '2026-09-17', order: '995001', cost: '4.10' }),
               reportRow({ date: '2026-09-16', order: '995002', cost: '0.00' })];
  const p = previewShippingCostReport(raw);
  assert.equal(p.kind, 'raw');
  for (const bad of ['Recipient', 'Shipping Paid', '+/-']) assert.ok(!Object.keys(p.rows[0]).includes(bad), bad);
  assert.ok(!JSON.stringify(p).includes('SYNTHETIC RECIPIENT'));
  assert.deepEqual([...p.costs], [['995001', 8.2]], 'a zero-cost row is not a cost');
  assert.deepEqual([p.facts.rows, p.facts.orders, p.facts.shippingCost], [3, 2, 8.2]);
  assert.equal(shippingCostReportKind(Object.keys(p.rows[0])), 'sanitized');
  assert.equal(previewShippingCostReport(p.rows).kind, 'sanitized', 'the stored sanitized form reloads');
  assert.throws(() => previewShippingCostReport([{ 'Shipment #': '1', 'Order #': '2' }]), e => e.code === 'report_schema_changed');
});
