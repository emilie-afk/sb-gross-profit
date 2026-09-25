/**
 * C3 correction: Shipping Cost Report orders that join no uploaded Shopify
 * order, and the raw-report → included-cost bridge. Synthetic data only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate } from '../shared/calculator.js';
import { previewShippingCostReport, parseShippingCostReport, sanitizeShippingCostReport } from '../shared/adapters/shippingCostReport.js';
import { unmatchedShippingOrders, exportPeriodOf, shippingCostBridge, filterUnmatched, unmatchedCsv, summarizeUnmatched,
         UNMATCHED_REASON as R, EXCLUDED_PENDING_MATCH, UNMATCHED_CSV_COLUMNS } from '../shared/unmatchedShipping.js';
import { row } from './fixtures.mjs';
import { reportRow } from './fixtures-shipping-cost.mjs';

// Shopify export: orders created 2026-08-01 .. 2026-08-31.
const shopify = [
  row({ Name: '#500100', 'Created at': '2026-08-01 09:00:00 -0700', 'Lineitem sku': 'S2KY1', Vendor: 'Succulents Box', 'Lineitem price': '20', Shipping: '5', Total: '25' }),
  row({ Name: '#500200', 'Created at': '2026-08-31 09:00:00 -0700', 'Lineitem sku': 'S2KY2', Vendor: 'Succulents Box', 'Lineitem price': '20', Shipping: '5', Total: '25' }),
];
const keys = new Set(['500100', '500200']);
const raw = [
  reportRow({ date: '2026-08-02', order: '500100', cost: '5.00' }),                        // matched
  reportRow({ date: '2026-07-30', order: '499000', cost: '4.00' }),                        // before
  reportRow({ date: '2026-08-03', order: '499001', cost: '3.00' }),                        // before (a package before the period)
  reportRow({ date: '2026-07-29', order: '499001', cost: '2.50' }),
  reportRow({ date: '2026-09-02', order: '600000', cost: '6.00' }),                        // after
  reportRow({ date: '2026-08-15', order: '600001', cost: '7.00' }),                        // inside: not found (number above range!)
  reportRow({ date: '2026-08-16', order: '100001', cost: '1.25' }),                        // inside: not found (number below range!)
  reportRow({ date: '2026-07-20', order: '700000', cost: '2.00' }), reportRow({ date: '2026-09-20', order: '700000', cost: '2.00' }),   // both sides → review
  reportRow({ date: '2026-08-20', order: '700001', cost: '9.00', insurance: '1.50' }),     // review amount
  reportRow({ date: '2026-08-21', order: 'MANUAL-7', cost: '3.30' }),                      // invalid order number
];
const period = exportPeriodOf(shopify);
const preview = () => previewShippingCostReport(raw);
const build = (p = preview(), k = keys, per = period) => unmatchedShippingOrders({ reportRows: p.parsedRows, invalidOrderRows: p.invalidOrderRows, shopifyOrderKeys: k, exportPeriod: per });
const find = (u, n) => u.orders.find(o => o.orderNumber === n);

test('reasons come from ship dates and the export period, never from order-number ranges', () => {
  assert.deepEqual(period, { from: '2026-08-01', to: '2026-08-31', basis: 'shopify_order_dates' });
  const u = build();
  assert.equal(find(u, '499000').reason, R.BEFORE);
  assert.equal(find(u, '499001').reason, R.BEFORE, 'any package shipped before the period proves the order predates it');
  assert.equal(find(u, '600000').reason, R.AFTER);
  assert.equal(find(u, '600001').reason, R.NOT_FOUND, 'an order number above the export range is not "after"');
  assert.equal(find(u, '100001').reason, R.NOT_FOUND, 'an order number below the export range is not "before"');
  assert.equal(find(u, '700000').reason, R.REVIEW);
  assert.equal(find(u, '700001').reason, R.REVIEW);
  assert.equal(find(u, 'MANUAL-7').reason, R.INVALID);
  assert.ok(!find(u, '500100'), 'matched orders are not listed');
  assert.ok(u.orders.every(o => o.status === EXCLUDED_PENDING_MATCH));
});

test('an explicitly requested export period takes precedence over the Shopify order dates', () => {
  const requested = exportPeriodOf(shopify, { from: '2026-08-01', to: '2026-09-30' });
  assert.equal(requested.basis, 'requested_export_period');
  assert.equal(find(build(preview(), keys, requested), '600000').reason, R.NOT_FOUND);
  const none = exportPeriodOf([]);
  assert.equal(find(build(preview(), keys, none), '499000').reason, R.REVIEW, 'without a period nothing is called before or after');
});

test('summary cards reconcile exactly to the unmatched total', () => {
  const u = build();
  const S = u.summary;
  assert.deepEqual(S.total, { orders: 8, costCents: 400 + 550 + 600 + 700 + 125 + 400 + 900 + 330 });
  assert.deepEqual(S.byReason[R.BEFORE], { orders: 2, costCents: 950 });
  assert.deepEqual(S.byReason[R.AFTER], { orders: 1, costCents: 600 });
  assert.deepEqual(S.byReason[R.NOT_FOUND], { orders: 2, costCents: 825 });
  assert.deepEqual(S.byReason[R.REVIEW], { orders: 2, costCents: 1300 });
  assert.deepEqual(S.byReason[R.INVALID], { orders: 1, costCents: 330 });
  assert.equal(S.reconciles, true);
  const sum = Object.values(S.byReason).reduce((a, v) => [a[0] + v.orders, a[1] + v.costCents], [0, 0]);
  assert.deepEqual(sum, [S.total.orders, S.total.costCents]);
  assert.equal(summarizeUnmatched([]).reconciles, true);
});

test('the table searches by order number, filters by reason and sorts by ship date or cost', () => {
  const u = build();
  assert.deepEqual(filterUnmatched(u.orders, { search: '#6000' }).map(o => o.orderNumber), ['600001', '600000']);
  assert.deepEqual(filterUnmatched(u.orders, { reason: R.BEFORE }).map(o => o.orderNumber), ['499001', '499000']);
  const byCostDesc = filterUnmatched(u.orders, { sortKey: 'cost', sortDir: 'desc' }).map(o => o.costCents);
  assert.deepEqual(byCostDesc, [...byCostDesc].sort((a, b) => b - a));
  const byDate = filterUnmatched(u.orders, { sortKey: 'shipDate' }).map(o => o.firstShipDate);
  assert.deepEqual(byDate, [...byDate].sort());
  assert.equal(filterUnmatched(u.orders, { sortKey: 'shipDate', sortDir: 'desc' })[0].firstShipDate, '2026-09-02');
  assert.equal(filterUnmatched(u.orders, { search: 'nothing-like-this' }).length, 0);
});

test('multi-row orders expand to their packages; each package carries only date, cost, provider and service', () => {
  const o = find(build(), '499001');
  assert.deepEqual([o.rowCount, o.firstShipDate, o.lastShipDate, o.costCents], [2, '2026-07-29', '2026-08-03', 550]);
  assert.deepEqual(o.rows, [{ shipDate: '2026-07-29', costCents: 250, provider: 'Stamps.com', service: 'GA' },
                            { shipDate: '2026-08-03', costCents: 300, provider: 'Stamps.com', service: 'GA' }]);
});

test('CSV download: exact columns, one line per order, safe cells, no customer fields', () => {
  const csv = unmatchedCsv(filterUnmatched(build().orders, {}));
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], UNMATCHED_CSV_COLUMNS.join(','));
  assert.equal(lines.length, 1 + 8);
  assert.ok(lines.some(l => l.startsWith('499001,2026-07-29 to 2026-08-03,5.50,2,Stamps.com,GA,')));
  for (const bad of ['Recipient', 'SYNTHETIC RECIPIENT', 'Shipping Paid', '+/-']) assert.ok(!csv.includes(bad), bad);
  const evil = unmatchedCsv([{ orderNumber: '=HYPERLINK("x")', firstShipDate: '2026-08-01', lastShipDate: '2026-08-01', costCents: 1, rowCount: 1,
                               providers: ['a'], services: ['b'], reason: R.INVALID, status: EXCLUDED_PENDING_MATCH, detail: 'd' }]);
  assert.ok(evil.includes('"=HYPERLINK(""x"")"'), 'a formula-looking cell is quoted');
});

test('privacy: Recipient, Shipping Paid and +/- never reach the unmatched list, the bridge or the CSV', () => {
  const p = preview();
  const u = build(p);
  const allowed = new Set(['orderNumber', 'reason', 'detail', 'status', 'firstShipDate', 'lastShipDate', 'costCents', 'rowCount', 'providers', 'services', 'rows']);
  for (const o of u.orders) for (const k of Object.keys(o)) assert.ok(allowed.has(k), k);
  const text = JSON.stringify([u, p.parsedRows, p.invalidOrderRows]);
  for (const bad of ['SYNTHETIC RECIPIENT', 'Recipient', 'Shipping Paid', '+/-']) assert.ok(!text.includes(bad), bad);
});

test('the Worker ingest still refuses an invalid order number; only the dashboard preview sets it aside', () => {
  const s = sanitizeShippingCostReport([reportRow({ date: '2026-08-21', order: 'MANUAL-7' })]);
  assert.throws(() => parseShippingCostReport(s.rows, { requestedFrom: '2026-08-01', requestedTo: '2026-08-31' }), e => e.code === 'report_invalid');
  const c = parseShippingCostReport(s.rows, { requestedFrom: '2026-08-01', requestedTo: '2026-08-31', invalidOrderNumbers: 'collect' });
  assert.deepEqual([c.rowCount, c.invalidOrderRows.length], [0, 1]);
});

// ─── Financial treatment and the bridge ──────────────────────────────────────
const engineRows = [
  ...shopify,
  row({ Name: '#500300', 'Created at': '2026-08-10 09:00:00 -0700', 'Lineitem sku': 'FH-POTHOS', Vendor: 'House Plant Dropship', 'Lineitem price': '30', Shipping: '9', Total: '39' }),
  row({ Name: '#500400', 'Created at': '2026-08-11 09:00:00 -0700', 'Lineitem sku': 'PL_FLF_4IN1', Vendor: 'Lively Root', 'Lineitem price': '60', Shipping: '15', Total: '75' }),
  row({ Name: '#500500', 'Created at': '2026-08-12 09:00:00 -0700', 'Lineitem sku': 'S2KY5', Vendor: 'Succulents Box', 'Lineitem price': '20', Shipping: '5', Total: '25', 'Cancelled at': '2026-08-13 09:00:00 -0700' }),
  row({ Name: '#500600', 'Created at': '2026-08-12 09:00:00 -0700', 'Lineitem sku': '', 'Lineitem name': 'Expedite fee', 'Lineitem price': '3', Total: '3' }),
  row({ Name: '#500700', 'Created at': '2026-07-15 09:00:00 -0700', 'Lineitem sku': 'S2KY7', Vendor: 'Succulents Box', 'Lineitem price': '20', Shipping: '5', Total: '25' }),
];
const engineRaw = [
  ...raw,
  reportRow({ date: '2026-08-11', order: '500300', cost: '8.00' }),     // pure HPD: report cost not used
  reportRow({ date: '2026-08-12', order: '500400', cost: '11.00' }),    // Lively Root: pass-through, report cost not used
  reportRow({ date: '2026-08-12', order: '500500', cost: '4.40' }),     // cancelled order
  reportRow({ date: '2026-08-12', order: '500600', cost: '2.20' }),     // no SKU line
  reportRow({ date: '2026-07-16', order: '500700', cost: '5.55' }),     // matched, outside the reporting period
  reportRow({ date: '2026-08-30', order: '500200', cost: '0.00' }),     // zero-cost row
];
function bridgeFor({ shopifyRows = engineRows, report = engineRaw, reportingPeriod = { from: '2026-08-01', to: '2026-08-31' } } = {}) {
  const p = previewShippingCostReport(report);
  const k = new Set(shopifyRows.map(r => r.Name.slice(1)));
  const u = unmatchedShippingOrders({ reportRows: p.parsedRows, invalidOrderRows: p.invalidOrderRows, shopifyOrderKeys: k, exportPeriod: exportPeriodOf(shopifyRows) });
  const lines = calculate(shopifyRows, p.costs, {}, {}, {}, {}, {}, {}, null, {}, null, null);
  return { u, lines, b: shippingCostBridge({ reportRows: p.parsedRows, invalidOrderRows: p.invalidOrderRows, lines, orderRows: shopifyRows, unmatched: u, period: reportingPeriod }) };
}

test('bridge: raw report cost − unmatched − documented exclusions = ShipStation cost in GP, with no residual', () => {
  const { b, u } = bridgeFor();
  const raw$ = [500, 400, 300, 250, 600, 700, 125, 200, 200, 900, 330, 800, 1100, 440, 220, 555, 0].reduce((s, c) => s + c, 0);
  assert.equal(b.rawCents, raw$);
  assert.equal(b.unmatchedCents, u.summary.total.costCents);
  const ex = Object.fromEntries(b.exclusions.map(e => [e.code, e.costCents]));
  assert.deepEqual(ex, { out_of_period: 555, pure_hpd: 800, lively_root: 1100, cancelled: 440, no_sku_line: 220 });
  assert.equal(b.engineShipStationCents, 500, 'only #500100 (and the zero-cost #500200) are ShipStation expense in the period');
  assert.equal(b.residualCents, 0);
  assert.equal(b.rawCents - b.unmatchedCents - b.exclusionCents, b.engineShipStationCents);
});

test('unmatched cost is never assigned to the period; a later Shopify export that contains the order moves it into GP', () => {
  const before = bridgeFor();
  const gpShipping = ls => Math.round(ls.filter(l => l.orderCat).reduce((s, l) => s + (l.shipPaidSS || 0), 0) * 100);
  assert.equal(gpShipping(before.lines), 500 + 555, 'engine total over all uploaded orders excludes every unmatched cost');
  assert.ok(before.u.orders.some(o => o.orderNumber === '600001'));
  const later = [...engineRows, row({ Name: '#600001', 'Created at': '2026-08-14 09:00:00 -0700', 'Lineitem sku': 'S2KY9', Vendor: 'Succulents Box', 'Lineitem price': '20', Shipping: '5', Total: '25' })];
  const after = bridgeFor({ shopifyRows: later });
  assert.ok(!after.u.orders.some(o => o.orderNumber === '600001'), 'matched now');
  assert.equal(after.b.unmatchedCents, before.b.unmatchedCents - 700);
  assert.equal(after.b.engineShipStationCents, before.b.engineShipStationCents + 700, 'its cost joins the order\'s own period');
  assert.equal(after.b.residualCents, 0);
});
