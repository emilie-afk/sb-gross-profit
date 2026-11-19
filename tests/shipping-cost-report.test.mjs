/**
 * Shipping Cost Report contract (C2): sanitizer and parser. Synthetic rows only.
 * The real-file aggregates (2,032 rows, $13,685.81, 2,007 orders, 24 multi-row
 * orders, 625 zero-paid rows with $4,101.62) were checked locally only; the
 * real report is never a fixture.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeShippingCostReport, parseShippingCostReport, aggregateByOrder, canonicalOrderKey, toCents,
  SHIPPING_COST_REPORT_COLUMNS, SHIPPING_COST_REPORT_DROPPED } from '../shared/adapters/shippingCostReport.js';
import { toCsvText } from '../shared/adapters/shopifyCsv.js';
import { parseCSV } from '../shared/calculator.js';
import { reportRow, multiRowOrder } from './fixtures-shipping-cost.mjs';

const P = { requestedFrom: '2026-08-01', requestedTo: '2026-09-21', expectedStore: 'Succulents Box (Shopify)' };
const raw = () => [
  reportRow({ order: '900101', date: '2026-08-10', cost: '6.25', paid: '7.99' }),
  ...multiRowOrder('900102', '2026-08-11', ['5.10', '7.40', '5.10']),     // Shipping Paid repeats; two identical packages
  reportRow({ order: '900103', date: '2026-08-12', cost: '6.40', paid: '0' }),   // prepaid-style zero paid, real cost
];

test('sanitizing keeps exactly the 15 approved columns and drops Recipient, Shipping Paid and +/-', () => {
  const s = sanitizeShippingCostReport(raw());
  assert.equal(SHIPPING_COST_REPORT_COLUMNS.length, 15);
  assert.deepEqual(Object.keys(s.rows[0]).sort(), [...SHIPPING_COST_REPORT_COLUMNS].sort());
  assert.deepEqual(s.dropped, ['Recipient', 'Shipping Paid', '+/-']);
  const text = toCsvText(s.rows, s.columns);
  for (const bad of ['SYNTHETIC RECIPIENT', 'Recipient', 'Shipping Paid', '+/-']) assert.ok(!text.includes(bad), bad);
  assert.equal(s.rows.length, 5);                                    // row count preserved
});

test('a changed raw report layout is refused, not guessed at', () => {
  assert.throws(() => sanitizeShippingCostReport([reportRow({ extra: { 'Ship To - Email': 'x' } })]), e => e.code === 'report_schema_changed');
  const [r] = [reportRow()]; delete r['Zone'];
  assert.throws(() => sanitizeShippingCostReport([r]), e => e.code === 'report_schema_changed');
});

test('parsing sums Shipping Cost per order across all rows and never collapses identical rows', () => {
  const p = parseShippingCostReport(sanitizeShippingCostReport(raw()).rows, P);
  assert.equal(p.rowCount, 5);
  assert.equal(p.shippingCostCents, 625 + 510 + 740 + 510 + 640);
  const a = aggregateByOrder(p.rows);
  assert.deepEqual({ ...a.get('900102') }, { orderKey: '900102', costCents: 1760, rowCount: 3, firstShipDate: '2026-08-11', lastShipDate: '2026-08-11' });
  assert.equal(a.get('900103').costCents, 640, 'zero Shipping Paid keeps its real cost');
  assert.deepEqual(p.reviewFlags, {});
  assert.ok(!('shippingPaid' in p.rows[0]) && !('Shipping Paid' in p.rows[0]), 'Shipping Paid is not even parsed');
});

test('totals survive CSV round-trip exactly (integer cents)', () => {
  const s = sanitizeShippingCostReport(raw());
  const again = parseShippingCostReport(parseCSV(toCsvText(s.rows, s.columns)), P);
  assert.equal(again.shippingCostCents, 3025);
  assert.equal(toCents('13685.81'), 1368581);
  assert.equal(toCents('0.10') + toCents('0.20'), 30);
});

test('ShipStation 475860 and Shopify #475860 are the same order key', () => {
  assert.equal(canonicalOrderKey('475860'), canonicalOrderKey('#475860'));
});

test('review conditions flag the import; they do not reject it or enter expense', () => {
  const rows = sanitizeShippingCostReport([
    reportRow({ order: '900201', cost: '0.00' }),
    reportRow({ order: '900202', insurance: '1.25' }),
    reportRow({ order: '900203', date: '8/12/2026 3:15:00 PM' }),
    reportRow({ order: '900204', store: 'Another Store' }),
  ]).rows;
  const p = parseShippingCostReport(rows, P);
  assert.deepEqual(p.reviewFlags, { zero_shipping_cost: 1, nonzero_insurance_cost: 1, ship_date_time_not_midnight: 1, unexpected_store: 1 });
  assert.equal(p.shippingCostCents, 0 + 625 + 625 + 625, 'Insurance Cost is not added to expense');
});

test('invalid files are rejected: outside the requested period, bad order number, bad money, unapproved columns', () => {
  const s = r => sanitizeShippingCostReport([r]).rows;
  assert.throws(() => parseShippingCostReport(s(reportRow({ date: '2026-07-31' })), P), e => e.code === 'report_invalid');
  assert.throws(() => parseShippingCostReport(s(reportRow({ order: 'ABC' })), P), e => e.code === 'report_invalid');
  assert.throws(() => parseShippingCostReport(s(reportRow({ cost: '$6.25' })), P), e => e.code === 'report_invalid');
  assert.throws(() => parseShippingCostReport([{ ...s(reportRow())[0], 'Recipient': 'X' }], P), e => e.code === 'unapproved_columns');
  assert.throws(() => parseShippingCostReport([], P), e => e.code === 'report_invalid');
  assert.deepEqual(SHIPPING_COST_REPORT_DROPPED, ['Recipient', 'Shipping Paid', '+/-']);
});
