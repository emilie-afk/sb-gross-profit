/**
 * Air Plant Shop scenario input (shared/apsMapping.js) and model (js/apsModel.js): duplicate rows, split
 * shipments, mixed shipments, missing mapping and monthly boundaries.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApsMap, dedupeRows, mappingShipDate, APS_MAP_SCHEMA } from '../shared/apsMapping.js';
import { apsOrders, apsCoverage, mergeApsInputs, apsProjection, apsExclusions, csvApsCosts } from '../js/apsModel.js';

// One row per item, shipment fields repeated (as the saved "SB GP weekly" template exports them).
const R = (ship, order, sku, qty, o = {}) => ({ 'Shipment ID': ship, 'Order Number': order, 'Tracking Number': `1Z${ship}`, 'Ship Date': o.date || '9/22/2026',
  'Modify Date': '', 'Void Flag': o.void ? 'true' : 'false', 'Void Date': '', Carrier: 'UPS', Service: o.service || 'UPS® Ground Saver', 'Carrier Fee': o.fee ?? '7.10',
  Rate: o.rate ?? '7.10', 'Insurance Cost': '0', 'Shipping Paid': '9.99', Provider: 'ShipStation', 'Carrier Transaction ID': '', 'Internal Transaction ID': '',
  'External ID': '', 'No Postage': 'false', 'Store Name': 'Succulents Box', 'Package Count': '1', Weight: '12', 'Item SKU': sku, 'Item Quantity': String(qty) });
const S = (order, date, service, cost) => ({ 'Ship Date': `${date} 12:00:00 AM`, 'Order #': order, Provider: 'UPS', Service: service, Package: 'Package', Items: '1', Zone: '5',
  'Shipping Cost': cost, 'Insurance Cost': '0', Weight: '12', 'Weight Unit': 'oz', Store: 'Succulents Box', Duties: '0', Taxes: '0', 'Import Fee': '0' });
const W = { from: '2026-08-10', to: '2026-10-04' };

const rows = [
  // 1001: APS-only, two items in one label; the export repeated an identical row (duplicate).
  R('S1', '1001', 'AS-TILL-1', 2), R('S1', '1001', 'AS-XERO-2', 1), R('S1', '1001', 'AS-XERO-2', 1),
  // 1002: split — one APS-only label and one MCG label, different ship dates.
  R('S2', '1002', 'AS-TILL-1', 1, { date: '9/22/2026' }), R('S3', '1002', 'S2KY1048', 3, { date: '9/23/2026' }),
  // 1003: mixed — one label holding APS and MCG items.
  R('S4', '1003', 'AS-TILL-1', 1), R('S4', '1003', 'S2KY1048', 2),
  // 1004: APS-only but a voided relabel exists (ignored).
  R('S5', '1004', 'AS-TILL-1', 1, { void: true }), R('S6', '1004', 'AS-TILL-1', 1),
  // 1005: split on the same day and service (two candidate rows with different costs → never guessed).
  R('S7', '1005', 'AS-TILL-1', 1, { date: '9/24/2026' }), R('S8', '1005', 'S2KY1048', 1, { date: '9/24/2026' }),
  // 1006: no APS item: not in the input.
  R('S9', '1006', 'S2KY1048', 4),
];
const scr = [S('1001', '9/22/2026', 'UPS® Ground Saver', '8.25'), S('1002', '9/22/2026', 'UPS® Ground Saver', '6.40'), S('1002', '9/23/2026', 'UPS® Ground Saver', '9.10'),
  S('1003', '9/22/2026', 'UPS® Ground Saver', '11.00'), S('1004', '9/22/2026', 'UPS® Ground Saver', '7.00'),
  S('1005', '9/24/2026', 'UPS® Ground Saver', '6.00'), S('1005', '9/24/2026', 'UPS® Ground Saver', '9.00')];

test('mapping: duplicate rows once, voided labels ignored, split / mixed / ambiguous never guessed', () => {
  const m = buildApsMap(rows, { window: W, scrRows: scr, source: { sanitizedSha256: 'abc', exportedAt: '2026-10-05T08:10:00Z' } });
  const by = Object.fromEntries(m.orders.map(o => [o.orderKey, o]));
  assert.equal(m.meta.schemaVersion, APS_MAP_SCHEMA);
  assert.equal(m.meta.duplicateRows, 1); assert.equal(m.meta.voidedShipments, 1);
  assert.deepEqual(Object.keys(by).sort(), ['1001', '1002', '1003', '1004', '1005']);
  assert.equal(by['1001'].status, 'aps_only'); assert.equal(by['1001'].apsUnits, 3, 'duplicate item row counted once');
  assert.deepEqual([by['1002'].status, by['1002'].apsCostCents], ['split_matched', 640], 'only the APS label’s report cost');
  assert.deepEqual([by['1003'].status, by['1003'].apsCostCents], ['mixed_shipment', null]);
  assert.equal(by['1004'].status, 'aps_only');
  assert.deepEqual([by['1005'].status, by['1005'].apsCostCents], ['split_unmatched', null]);
  // Without report rows, split orders are not costed.
  assert.equal(buildApsMap(rows, { window: W }).orders.find(o => o.orderKey === '1002').status, 'split_cost_unavailable');
  // A label count that disagrees with the report.
  const extra = buildApsMap(rows, { window: W, scrRows: [...scr, S('1001', '9/25/2026', 'UPS® Ground Saver', '5.00')] });
  assert.equal(extra.orders.find(o => o.orderKey === '1001').status, 'shipment_count_mismatch');
  assert.equal(dedupeRows([{ a: 1 }, { a: '1' }, { a: 2 }]).duplicates, 1);
  assert.equal(mappingShipDate('9/22/2026 10:31:00 AM'), '2026-09-22'); assert.equal(mappingShipDate('2026-09-22T10:00'), '2026-09-22');
});

// Saved-report lines (storedLines shape): order-level ShipStation expense on the first line.
const L = (orderNum, sku, qty, rev, cogs, o = {}) => ({ orderNum: `#${orderNum}`, date: o.date || '2026-09-21', source: 'web', sku, product: sku, qty,
  lineRevenue: rev, lineCogs: cogs, shipPaidSS: o.ss ?? null, shipPaid: o.ss ?? null });
const lines = [
  L('1001', 'AS-TILL-1', 2, 24, 8, { ss: 8.25 }), L('1001', 'AS-XERO-2', 1, 12, 4),
  L('1002', 'AS-TILL-1', 1, 12, 4, { ss: 15.5 }), L('1002', 'S2KY1048', 3, 30, 12),
  L('1003', 'AS-TILL-1', 1, 12, 4, { ss: 11 }), L('1003', 'S2KY1048', 2, 20, 8),
  L('1004', 'AS-TILL-1', 1, 12, null, { ss: 7 }),                          // product cost unknown
  L('1007', 'AS-TILL-1', 3, 36, 12, { ss: 9 }),                            // not in the export
];

test('model: costs from the published expense (APS-only) or matched labels; everything else excluded with its reason', () => {
  // As the reader route returns them: the split order's rows verified against the published snapshot.
  const input = mergeApsInputs([{ versions: [], orders: buildApsMap(rows, { window: W, scrRows: scr }).orders
    .map(o => ({ ...o, exportedAt: 't1', ...(o.status === 'split_matched' ? { snapshotCheck: { status: 'verified' } } : {}) })) }]).orders;
  const r = apsOrders(lines, { mode: 'stored', input });
  const by = Object.fromEntries(r.map(o => [o.orderNum, o]));
  assert.deepEqual([by['#1001'].apsShipCost, by['#1001'].apsGp, by['#1001'].included], [8.25, 15.75, true]);
  assert.deepEqual([by['#1002'].apsShipCost, by['#1002'].apsGp], [6.4, 1.6], 'only the APS label, not the order’s $15.50');
  assert.deepEqual([by['#1003'].included, by['#1003'].apsShipCost], [false, null]); assert.match(by['#1003'].reason, /no allocation is guessed/);
  assert.deepEqual([by['#1004'].included, by['#1004'].apsShipCost], [false, 7]); assert.match(by['#1004'].reason, /no known product cost/);
  assert.equal(by['#1007'].status, 'not_in_mapping'); assert.equal(by['#1007'].included, false);
  const p = apsProjection(r, { flat: [1, 1, 1], pct: [10, 0, 0] });
  assert.deepEqual([p.orders, p.excluded, p.revenue, p.gp], [2, 3, 48, 17.35]);
  assert.equal(p.A.discount, 2, 'only #1001 (3 APS items: 2nd and 3rd discounted) among the included');
  assert.equal(apsExclusions(r).length, 3);
});

test('coverage: the export must span the period; otherwise the exact missing-data reason', () => {
  assert.match(apsCoverage({ from: '2026-09-01', to: '2026-09-30' }, []).reason, /No ShipStation line-item export/);
  const v = [{ versionId: 'v1', windowFrom: '2026-08-10', windowTo: '2026-10-04' }];
  assert.equal(apsCoverage({ from: '2026-09-01', to: '2026-09-30' }, v).available, true);
  const aug = apsCoverage({ from: '2026-08-01', to: '2026-08-31' }, v);
  assert.equal(aug.available, false); assert.match(aug.reason, /covers ship dates 2026-08-10 to 2026-10-04, not the whole period \(2026-08-01 to 2026-08-31\)/);
});

test('monthly boundaries: weeks merged by order, newest export wins, only the month’s orders count', () => {
  // The week of Aug 31 holds orders dated Aug 31 (August) and Sep 1–6 (September).
  const wk1 = { versions: [{ versionId: 'v1', windowFrom: '2026-08-10', windowTo: '2026-10-04' }],
                orders: [{ orderKey: '2001', status: 'aps_only', exportedAt: 'a' }, { orderKey: '2002', status: 'aps_only', exportedAt: 'a' }] };
  const wk2 = { versions: [{ versionId: 'v1', windowFrom: '2026-08-10', windowTo: '2026-10-04' }, { versionId: 'v2', windowFrom: '2026-08-17', windowTo: '2026-10-11' }],
                orders: [{ orderKey: '2002', status: 'split_matched', apsCostCents: 300, scrOrderCents: 900, exportedAt: 'b', snapshotCheck: { status: 'other_week' } }] };
  // The order's own week (Aug 31) answers for the same current row with the check against its published snapshot.
  const wk3 = { versions: [], orders: [{ orderKey: '2002', status: 'split_matched', apsCostCents: 300, scrOrderCents: 900, exportedAt: 'b', snapshotCheck: { status: 'verified' } }] };
  const merged = mergeApsInputs([wk1, wk2, wk3]);
  assert.equal(merged.orders.get('2002').snapshotCheck.status, 'verified', 'the order’s own week decides the check');
  assert.equal(mergeApsInputs([wk3, wk2]).orders.get('2002').snapshotCheck.status, 'verified', 'whatever the order of the weeks');
  assert.equal(merged.versions.length, 2, 'every version is kept');
  assert.equal(merged.orders.get('2002').status, 'split_matched', 'the newer export wins');
  // September report: lines are already limited to September order dates by the period plan.
  const sepLines = [L('2002', 'AS-TILL-1', 2, 24, 8, { date: '2026-09-01', ss: 9 })];
  const r = apsOrders(sepLines, { mode: 'stored', input: merged.orders });
  assert.deepEqual(r.map(o => [o.orderNum, o.apsShipCost]), [['#2002', 3]]);
  assert.ok(!r.some(o => o.orderNum === '#2001'), 'the Aug 31 order stays in August');
});

test('CSV upload: the line-item file’s Rate per APS-only label; mixed labels never counted', () => {
  const input = mergeApsInputs([{ orders: buildApsMap(rows, { window: W }).orders }]).orders;
  const costs = csvApsCosts(rows.map(r => ({ ...r, 'Shipment #': r['Shipment ID'], 'Order #': r['Order Number'] })), input);
  assert.equal(costs.get('1001'), 7.1, 'one label, three item rows, rate counted once');
  assert.equal(costs.get('1002'), 7.1, 'split: the APS label only');
  assert.equal(costs.has('1003'), false, 'mixed: no cost');
  const r = apsOrders(lines, { mode: 'csv', input, csvCosts: costs });
  assert.equal(r.find(o => o.orderNum === '#1002').apsShipCost, 7.1);
});

test('split costs are pinned per ship date; used only when the reader route verified those exact rows', () => {
  const m = buildApsMap(rows, { window: W, scrRows: scr, scrSource: { sanitizedSha256: 'e'.repeat(64), from: '2026-08-10', to: '2026-10-04' } });
  const o = m.orders.find(x => x.orderKey === '1002');
  assert.deepEqual([o.status, o.apsCostCents, o.scrOrderCents], ['split_matched', 640, 1550]);
  // One pin per ship date: [date, labels, cents, apsLabels, apsCents, rowVersion]; one kind per date → no row version.
  assert.deepEqual(o.scrPins, [['2026-09-22', 1, 640, 1, 640, null], ['2026-09-23', 1, 910, 0, 0, null]]);
  assert.deepEqual(m.meta.scrSource, { sanitizedSha256: 'e'.repeat(64), from: '2026-08-10', to: '2026-10-04' }, 'report provenance kept');
  const at = check => new Map(m.orders.map(x => [x.orderKey, x.status === 'split_matched' ? { ...x, snapshotCheck: check } : x]));
  const cost = (input, ls = lines) => apsOrders(ls, { mode: 'stored', input }).find(x => x.orderNum === '#1002');
  assert.equal(cost(at({ status: 'verified' })).apsShipCost, 6.4, 'verified rows: the APS label’s $6.40');
  for (const check of [{ status: 'unverified', reason: 'rows_differ' }, { status: 'other_week' }, undefined]) {
    const r = cost(at(check));
    assert.deepEqual([r.status, r.apsShipCost, r.included], ['split_cost_unverified', null, false], JSON.stringify(check));
    assert.match(r.reason, /exact rows accepted in the published report/);
  }
  // Verified, but the published expense differs from the pinned rows' total: still not used.
  assert.equal(cost(at({ status: 'verified' }), lines.map(l => (l.orderNum === '#1002' && l.shipPaidSS !== null ? { ...l, shipPaidSS: 16.1 } : l))).status, 'split_cost_unverified');
});

test('split on one ship date (APS and other labels): the owning report version’s retained rows decide, or no cost', () => {
  const same = [R('T1', '3001', 'AS-TILL-1', 1, { date: '9/25/2026', service: 'USPS Ground Advantage' }), R('T2', '3001', 'S2KY1048', 1, { date: '9/25/2026' })];
  const scr2 = [S('3001', '9/25/2026', 'USPS Ground Advantage', '5.00'), S('3001', '9/25/2026', 'UPS® Ground Saver', '10.00')];
  // Without the owner's rows: not costed, and the pair to read is listed.
  const a = buildApsMap(same, { window: W, scrRows: scr2 });
  assert.deepEqual([a.orders[0].status, a.orders[0].apsCostCents, a.orders[0].pinReason], ['split_cost_unverified', null, 'rows_not_read']);
  assert.deepEqual(a.meta.needRows, [['2026-09-25', '3001']]);
  // With the owning version's rows: the APS share comes from THOSE rows and the version is pinned.
  const owner = { versionId: 'scr_' + 'a'.repeat(20), rows: [{ service: 'USPS Ground Advantage', cents: 800 }, { service: 'UPS® Ground Saver', cents: 700 }] };
  const b = buildApsMap(same, { window: W, scrRows: scr2, rowsFor: (d, k) => (d === '2026-09-25' && k === '3001' ? owner : null) });
  assert.deepEqual([b.orders[0].status, b.orders[0].apsCostCents, b.orders[0].scrOrderCents], ['split_matched', 800, 1500]);
  assert.deepEqual(b.orders[0].scrPins, [['2026-09-25', 2, 1500, 1, 800, owner.versionId]]);
  assert.equal(b.meta.needRows, undefined);
  // Unreadable or unmatchable owner rows: no cost.
  assert.equal(buildApsMap(same, { window: W, scrRows: scr2, rowsFor: () => null }).orders[0].pinReason, 'rows_unavailable');
  const ambiguous = { ...owner, rows: [{ service: 'X', cents: 800 }, { service: 'Y', cents: 700 }] };
  assert.equal(buildApsMap(same, { window: W, scrRows: scr2, rowsFor: () => ambiguous }).orders[0].pinReason, 'rows_unmatched');
});
