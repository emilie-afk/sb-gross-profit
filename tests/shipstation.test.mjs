/**
 * ShipStation expense-field tests (Revision 4 A54–A62, Revision 5 A63).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseShipStation } from '../shared/calculator.js';
import {
  normalizeShipStationRows, selectShipmentExpense, compareCarrierFeeToRate,
  classifyInsuranceTreatment, DEFAULT_EXPENSE_POLICY,
} from '../shared/adapters/shipstation.js';
import { toLegacyShipStationCosts } from '../shared/adapters/legacy.js';
import { ssCustom, ssRow } from './fixtures-normalized.mjs';

const one = rows => normalizeShipStationRows(rows).shipments[0];

test('the expense policy is provisional by default and insurance is disclosed, not added', () => {
  assert.equal(DEFAULT_EXPENSE_POLICY.locked, false);
  assert.deepEqual(DEFAULT_EXPENSE_POLICY.priority, ['carrierFee', 'legacyRate']);
  assert.equal(DEFAULT_EXPENSE_POLICY.insuranceTreatment, 'awaiting_confirmation');
});

test('A54: Carrier Fee wins over a different legacy Rate', () => {
  const e = selectShipmentExpense(one(ssCustom({ fee: '6.10', rate: '7.25', paid: '5.99' })));
  assert.deepEqual([e.amount, e.field, e.status], [6.10, 'carrier_fee', 'complete']);
});

test('A55: a positive Carrier Fee recovers a zero legacy Rate', () => {
  const e = selectShipmentExpense(one(ssCustom({ fee: '5.41', rate: '0.00', paid: '5.99' })));
  assert.deepEqual([e.amount, e.field], [5.41, 'carrier_fee']);
});

test('A56: blank Carrier Fee falls back to a positive legacy Rate', () => {
  const e = selectShipmentExpense(one(ssCustom({ fee: '', rate: '4.80', paid: '5.99' })));
  assert.deepEqual([e.amount, e.field], [4.80, 'legacy_rate']);
});

test('A57: both costs zero with Shipping Paid positive → expense missing, Shipping Paid not used', () => {
  const s = one(ssCustom({ fee: '0.00', rate: '0.00', paid: '5.99' }));
  const e = selectShipmentExpense(s);
  assert.equal(e.amount, null);
  assert.equal(e.status, 'missing');
  assert.equal(s.shippingPaid, 5.99);                      // kept as a field
});

test('A58: Shipping Paid never becomes expense anywhere in the cost map', () => {
  const rows = [
    ...ssCustom({ shipment: 'S1', order: '900001', fee: '', rate: '', paid: '9.99' }),
    ...ssCustom({ shipment: 'S2', order: '900002', fee: '0', rate: '0', paid: '12.00' }),
    ...ssCustom({ shipment: 'S3', order: '900003', fee: '3.10', rate: '', paid: '8.00' }),
  ];
  const costs = toLegacyShipStationCosts(normalizeShipStationRows(rows).shipments);
  assert.deepEqual([...costs.entries()], [['900003', 3.10]]);
});

test('A59: a voided label is excluded from expense', () => {
  const e = selectShipmentExpense(one(ssCustom({ fee: '6.00', voided: 'true' })));
  assert.equal(e.status, 'voided');
  assert.equal(e.amount, null);
});

test('A61: rows of one shipment that disagree on cost are flagged, not silently resolved', () => {
  const rows = [
    ...ssCustom({ shipment: 'S9', fee: '6.00', items: [{ sku: 'A', qty: 1 }] }),
    ...ssCustom({ shipment: 'S9', fee: '7.00', items: [{ sku: 'B', qty: 1 }] }),
  ];
  const { shipments, diagnostics } = normalizeShipStationRows(rows);
  assert.deepEqual(diagnostics.rowDisagreements, [{ shipmentNo: 'S9', field: 'carrierFee' }]);
  assert.equal(selectShipmentExpense(shipments[0]).status, 'conflict');
  assert.equal(shipments[0].items.length, 2);
});

test('every row is validated: a shipment whose first row is blank still reads a later positive fee', () => {
  const rows = [
    ...ssCustom({ shipment: 'S5', fee: '', items: [{ sku: 'A', qty: 1 }] }),
    ...ssCustom({ shipment: 'S5', fee: '4.20', items: [{ sku: 'B', qty: 1 }] }),
  ];
  assert.equal(selectShipmentExpense(one(rows)).amount, 4.20);
});

test('A62: the legacy manual-upload parser is unchanged, and matches the normalized path on Rate-only exports', () => {
  const rows = [
    ssRow({ 'Shipment #': 'S1', 'Order #': '900001', 'Rate': '5.41', 'Shipping Paid': '5.99', 'Item SKU': 'A' }),
    ssRow({ 'Shipment #': 'S1', 'Order #': '900001', 'Rate': '5.41', 'Shipping Paid': '5.99', 'Item SKU': 'B' }),
    ssRow({ 'Shipment #': 'S2', 'Order #': '900001', 'Rate': '3.20', 'Shipping Paid': '5.99', 'Item SKU': 'C' }),
    ssRow({ 'Shipment #': 'S3', 'Order #': '900002', 'Rate': '0.00', 'Shipping Paid': '6.99', 'Item SKU': 'D' }),
  ];
  const legacy = parseShipStation(rows);
  assert.equal(legacy.costColumnUsed, 'Rate');
  assert.equal(legacy.costs.get('900001'), 5.41 + 3.20);
  assert.equal(legacy.costs.get('900002'), 0);
  const norm = toLegacyShipStationCosts(normalizeShipStationRows(rows, { sourceFormat: 'legacy' }).shipments);
  assert.equal(norm.get('900001'), legacy.costs.get('900001'));
  assert.equal(norm.has('900002'), false);                     // engine reads 0 and absent the same way
});

test('customer columns are never read; only their header names are reported', () => {
  const { shipments, diagnostics } = normalizeShipStationRows(ssCustom({ fee: '5' }));
  assert.ok(diagnostics.ignoredColumns.includes('Recipient'));
  assert.ok(!JSON.stringify(shipments).includes('SYNTHETIC RECIPIENT'));
});

test('A63: insurance treatment — disclose by default, add only once confirmed', () => {
  const s = one(ssCustom({ fee: '8.00', insurance: '1.25' }));
  assert.deepEqual([selectShipmentExpense(s).amount, selectShipmentExpense(s).insuranceDisclosed], [8.00, 1.25]);
  assert.equal(selectShipmentExpense(s, { ...DEFAULT_EXPENSE_POLICY, insuranceTreatment: 'add' }).amount, 9.25);
  assert.equal(selectShipmentExpense(s, { ...DEFAULT_EXPENSE_POLICY, insuranceTreatment: 'included' }).amount, 8.00);

  const shipments = [s, one(ssCustom({ shipment: 'S2', fee: '6.00', insurance: '0.90' }))];
  assert.equal(classifyInsuranceTreatment(shipments, { S1: 9.25, S2: 6.90 }).outcome, 'add');
  assert.equal(classifyInsuranceTreatment(shipments, { S1: 8.00, S2: 6.00 }).outcome, 'included');
  assert.equal(classifyInsuranceTreatment(shipments, { S1: 8.00, S2: 6.90 }).outcome, 'awaiting_confirmation');
  assert.equal(classifyInsuranceTreatment(shipments, {}).outcome, 'awaiting_confirmation');
});

test('Carrier Fee vs Rate comparison reports every category the priority lock needs', () => {
  const rows = [
    ...ssCustom({ shipment: 'A', fee: '5.00', rate: '5.00' }),
    ...ssCustom({ shipment: 'B', fee: '5.00', rate: '6.50' }),
    ...ssCustom({ shipment: 'C', fee: '0', rate: '4.00' }),
    ...ssCustom({ shipment: 'D', fee: '4.40', rate: '0' }),
    ...ssCustom({ shipment: 'E', fee: '0', rate: '0' }),
  ];
  const c = compareCarrierFeeToRate(normalizeShipStationRows(rows).shipments);
  assert.deepEqual([c.compared, c.exactMatches, c.differences, c.differenceSum, c.zeroFeePositiveRate, c.positiveFeeZeroRate, c.bothZero],
                   [5, 1, 1, -1.5, 1, 1, 1]);
});
