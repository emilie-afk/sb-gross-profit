/**
 * Air Plant Shop mapping on the collector: the saved template's columns only, reduced on the PC to per-order
 * classifications (no rows, tracking numbers or file leave it), the export window (rolling eight weeks, widened
 * for the backfill of published weeks), and the "steps not recorded yet" state.
 */
import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { prepareExport, apsExportWindow, apsStepsReady, assertKindEnabled, KINDS } from '../automation/shipstation-export/src/kinds.mjs';
import { toCsvText } from '../shared/adapters/shopifyCsv.js';
import { APS_MAPPING_COLUMNS } from '../shared/apsMapping.js';

// The live format's exact header row (Oct 7, 2026): ShipmentID,OrderNumber,ShipDate,SKU,Quantity,Voided.
const row = (ship, order, sku, date = '9/22/2026 10:31:00 AM') => ({ ShipmentID: ship, OrderNumber: order, ShipDate: date, SKU: sku, Quantity: '1', Voided: 'False' });
const week = { weekStart: '2026-09-28', weekEnd: '2026-10-04' };

test('APS export: exact template columns; only per-order classifications leave the PC', () => {
  const text = toCsvText([row('S1', '1001', 'AS-T-1'), row('S1', '1001', 'AS-T-1'), row('S2', '1002', 'AS-T-1'), row('S3', '1002', 'S2KY1048')], APS_MAPPING_COLUMNS);
  const p = prepareExport('shipstation_aps_mapping', text, { week, exportedAt: '2026-10-05T08:10:00Z', apsWindow: { from: '2026-08-03', to: '2026-10-04' } });
  assert.equal(p.path, '/v1/collect/aps-map');
  assert.deepEqual(Object.keys(p.payload), ['meta', 'orders']);
  const sent = JSON.stringify(p.payload);
  assert.ok(!sent.includes('S2KY1048'), 'no item SKUs'); assert.ok(!sent.includes('S1'), 'no shipment numbers');
  assert.equal(p.payload.meta.duplicateRows, 1, 'the repeated row counted once');
  assert.deepEqual(p.payload.orders.map(o => [o.orderKey, o.status]), [['1001', 'aps_only'], ['1002', 'split_cost_unavailable']]);
  // A file with an extra column (e.g. a recipient) is refused.
  const withName = toCsvText([{ ...row('S1', '1001', 'AS-T-1'), 'Recipient': 'x' }], [...APS_MAPPING_COLUMNS, 'Recipient']);
  assert.equal(prepareExport('shipstation_aps_mapping', withName, { week, exportedAt: 'x', apsWindow: { from: '2026-08-03', to: '2026-10-04' } }).refused, 'refused_customer_columns');
  assert.equal(KINDS.shipstation_aps_mapping.path, '/v1/collect/aps-map');
  // A changed format (a column missing) is refused too.
  const short = toCsvText([{ ShipmentID: 'S1', OrderNumber: '1', ShipDate: '9/22/2026', SKU: 'AS-T-1', Quantity: '1' }], APS_MAPPING_COLUMNS.slice(0, 5));
  assert.equal(prepareExport('shipstation_aps_mapping', short, { week, exportedAt: 'x', apsWindow: { from: '2026-08-03', to: '2026-10-04' } }).refused, 'refused_customer_columns');
});

test('APS export window: backfill from Aug 3 until the stored mapping reaches it, then the rolling eight weeks; a missed run is caught up', () => {
  assert.deepEqual([apsExportWindow(week, null).from, apsExportWindow(week, null).to], ['2026-08-03', '2026-10-04']);
  assert.equal(apsExportWindow(week, { coveredFrom: '2026-08-10', coveredTo: '2026-10-04' }).from, '2026-08-03', 'published Aug 3 week not yet covered');
  assert.equal(apsExportWindow(week, { coveredFrom: '2026-08-03', coveredTo: '2026-10-04' }).from, '2026-08-10', 'rolling eight weeks');
  const later = { weekStart: '2026-11-30', weekEnd: '2026-12-06' };
  assert.equal(apsExportWindow(later, { coveredFrom: '2026-08-03', coveredTo: '2026-10-04' }).from, '2026-10-05', 'gap after a missed run');
  assert.equal(apsExportWindow(week, { coveredFrom: '2026-08-03', coveredTo: '2026-10-04' }).fromUS, '08/10/2026');
});

test('APS export: steps must be recorded; on by default, can be turned off', () => {
  const placeholder = { kinds: { shipstation_aps_mapping: { exportSteps: [{ action: 'click', selector: 'REPLACE: export menu button' }, { action: 'download', selector: 'REPLACE: x' }] } } };
  assert.equal(apsStepsReady(placeholder), false);
  assert.throws(() => assertKindEnabled('shipstation_aps_mapping', placeholder), e => e.code === 'aps_mapping_not_configured');
  const example = JSON.parse(fs.readFileSync(new URL('../automation/shipstation-export/config.example.json', import.meta.url), 'utf8'));
  const recorded = { kinds: { shipstation_aps_mapping: { exportSteps: example.kinds.shipstation_aps_mapping.exportSteps } } };
  assert.equal(apsStepsReady({ exportSteps: recorded.kinds.shipstation_aps_mapping.exportSteps }), false, 'top-level steps (the dormant template) are not used');
  assert.equal(assertKindEnabled('shipstation_aps_mapping', recorded), true);
  assert.throws(() => assertKindEnabled('shipstation_aps_mapping', { kinds: { shipstation_aps_mapping: { ...recorded.kinds.shipstation_aps_mapping, enabled: false } } }), e => e.code === 'aps_mapping_off');
  // The recorded steps take the file from the new tab at the context level.
  const dl = recorded.kinds.shipstation_aps_mapping.exportSteps.at(-1);
  assert.deepEqual([dl.action, dl.capture, dl.captureScope], ['download', '**/downloads/**/*.csv', 'context']);
  // The dormant rollback kind is unchanged.
  assert.throws(() => assertKindEnabled('shipstation_mapping_export', recorded), e => e.code === 'mapping_export_dormant');
});

test('split dates holding both kinds of label: rows read from the owning report version’s retained source, checked against its stored day', async () => {
  const { scrRowsResolver } = await import('../automation/collector/src/freeTier.mjs');
  const { parseShippingCostReport, SHIPPING_COST_REPORT_COLUMNS } = await import('../shared/adapters/shippingCostReport.js');
  const { dayGroups, dayHash } = await import('../shared/scrDays.js');
  const { parseCSV } = await import('../shared/calculator.js');
  const S = (order, date, service, cost) => ({ 'Ship Date': `${date} 12:00:00 AM`, 'Order #': order, Provider: 'UPS', Service: service, Package: 'Package', Items: '1', Zone: '5',
    'Shipping Cost': cost, 'Insurance Cost': '0', Weight: '12', 'Weight Unit': 'oz', Store: 'Succulents Box', Duties: '0', Taxes: '0', 'Import Fee': '0' });
  const VA = 'scr_' + 'a'.repeat(20), VK = 'scr_' + 'c'.repeat(20);
  const csvA = toCsvText([S('3001', '9/25/2026', 'USPS Ground Advantage', '8.00'), S('3001', '9/25/2026', 'UPS Ground', '7.00'), S('3009', '9/25/2026', 'UPS Ground', '4.00'),
    S('3002', '9/26/2026', 'UPS Ground', '5.00')], SHIPPING_COST_REPORT_COLUMNS);
  const csvK = toCsvText([S('3002', '9/26/2026', 'USPS Ground Advantage', '6.00'), S('3002', '9/26/2026', 'UPS Ground', '5.00')], SHIPPING_COST_REPORT_COLUMNS);
  const from = '2026-09-01', to = '2026-09-30';
  const groupsOf = (csv, date) => dayGroups(parseShippingCostReport(parseCSV(csv), { requestedFrom: from, requestedTo: to }).rows).get(date);
  const g25 = groupsOf(csvA, '2026-09-25'), h25 = await dayHash('2026-09-25', g25);
  // Sep 26 is owned by A, which kept order 3002's accepted cost from an earlier report K (A omitted one of its labels).
  const g26 = [['3002', 1100, 2]], h26 = await dayHash('2026-09-26', g26);
  const calls = [];
  const c = { call: async (m, p, o = {}) => {
    calls.push(p);
    if (p === '/v1/collect/scr/owners') return { owners: [], detail: [['2026-09-25', VA, h25, []], ['2026-09-26', VA, h26, [['3002', VK]]]],
                                                versions: [[VA, 'src_' + '1'.repeat(20), from, to], [VK, 'src_' + '2'.repeat(20), from, to]] };
    if (p === '/v1/collect/scr/days') return { days: o.json.keys.map(([v, d]) => [v, d, d.endsWith('25') ? h25 : h26, JSON.stringify(d.endsWith('25') ? g25 : g26)]) };
    const src = p.includes('1'.repeat(20)) ? csvA : csvK;
    if (/segments\/0$/.test(p)) return { text: async () => src };
    return { segments: [{}] };
  } };
  const rowsFor = await scrRowsResolver(c, [['2026-09-25', '3001'], ['2026-09-26', '3002']]);
  assert.deepEqual(rowsFor('2026-09-25', '3001'), { versionId: VA, rows: [{ service: 'USPS Ground Advantage', cents: 800 }, { service: 'UPS Ground', cents: 700 }] });
  assert.deepEqual(rowsFor('2026-09-26', '3002'), { versionId: VK, rows: [{ service: 'USPS Ground Advantage', cents: 600 }, { service: 'UPS Ground', cents: 500 }] }, 'the kept cost’s own source');
  assert.equal(calls.filter(p => /segments/.test(p)).length, 2, 'each retained source read once');
  // A source whose rows do not rebuild the stored day is not used.
  const tampered = { call: async (m, p, o) => (/segments\/0$/.test(p) && p.includes('1'.repeat(20)) ? { text: async () => csvA.replace('8.00', '9.00') } : c.call(m, p, o)) };
  assert.equal((await scrRowsResolver(tampered, [['2026-09-25', '3001']]))('2026-09-25', '3001'), null);
  // An older Worker without version detail: nothing is read, nothing is pinned.
  const old = { call: async () => ({ owners: [] }) };
  assert.equal((await scrRowsResolver(old, [['2026-09-25', '3001']]))('2026-09-25', '3001'), null);
});

test('prepareExport lists the split dates whose rows must be read, keeps them out of the upload, and pins them when given', () => {
  const S = (order, cost) => ({ 'Ship Date': '9/25/2026 12:00:00 AM', 'Order #': order, Provider: 'UPS', Service: 'UPS Ground', Package: 'Package', Items: '1', Zone: '5',
    'Shipping Cost': cost, 'Insurance Cost': '0', Weight: '12', 'Weight Unit': 'oz', Store: 'Succulents Box', Duties: '0', Taxes: '0', 'Import Fee': '0' });
  const text = toCsvText([row('T1', '3001', 'AS-TILL-1', '9/25/2026 9:00:00 AM'), row('T2', '3001', 'S2KY1048', '9/25/2026 9:05:00 AM')], APS_MAPPING_COLUMNS);
  const o = { week, exportedAt: 'x', apsWindow: { from: '2026-08-03', to: '2026-10-04' }, scrRows: [S('3001', '6.00'), S('3001', '6.00')] };
  const a = prepareExport('shipstation_aps_mapping', text, o);
  assert.deepEqual(a.needRows, [['2026-09-25', '3001']]);
  assert.equal(a.payload.meta.needRows, undefined, 'not sent to the Worker');
  assert.equal(a.payload.orders[0].status, 'split_cost_unverified');
  const vid = 'scr_' + 'a'.repeat(20);
  const b = prepareExport('shipstation_aps_mapping', text, { ...o, rowsFor: () => ({ versionId: vid, rows: [{ service: 'UPS Ground', cents: 600 }, { service: 'UPS Ground', cents: 600 }] }) });
  assert.deepEqual([b.payload.orders[0].status, b.payload.orders[0].scrPins], ['split_matched', [['2026-09-25', 2, 1200, 1, 600, vid]]]);
  // The live format has no Service column: two labels on one date with different costs cannot be told apart (no cost).
  const c = prepareExport('shipstation_aps_mapping', text, { ...o, scrRows: [S('3001', '6.00'), S('3001', '9.00')] });
  assert.equal(c.payload.orders[0].status, 'split_unmatched');
});

test('v2 format: ServiceCode tells same-date labels apart; ambiguous labels stay excluded; the first format is still accepted', () => {
  const S = (order, service, cost) => ({ 'Ship Date': '9/25/2026 12:00:00 AM', 'Order #': order, Provider: 'UPS', Service: service, Package: 'Package', Items: '1', Zone: '5',
    'Shipping Cost': cost, 'Insurance Cost': '0', Weight: '12', 'Weight Unit': 'oz', Store: 'Succulents Box', Duties: '0', Taxes: '0', 'Import Fee': '0' });
  const r2 = (ship, order, sku, svc) => ({ ...row(ship, order, sku, '9/25/2026 9:00:00 AM'), ServiceCode: svc });
  const o = { week, exportedAt: 'x', apsWindow: { from: '2026-08-03', to: '2026-10-04' } };
  // 3001: APS label GA $5.00 and MCG label Ground $9.00 on one date (the report's Service holds the same codes).
  // 3002: two labels on one date, both GA, $5.00 and $9.00: which one is APS cannot be known.
  const text = toCsvText([r2('T1', '3001', 'AS-TILL-1', 'GA'), r2('T2', '3001', 'S2KY1048', 'Ground'),
                          r2('T3', '3002', 'AS-TILL-1', 'GA'), r2('T4', '3002', 'S2KY1048', 'GA')], APS_MAPPING_COLUMNS);
  const scrRows = [S('3001', 'GA', '5.00'), S('3001', 'Ground', '9.00'), S('3002', 'GA', '5.00'), S('3002', 'GA', '9.00')];
  const a = prepareExport('shipstation_aps_mapping', text, { ...o, scrRows });
  assert.equal(a.facts.format, 'SB GP APS mapping v2');
  assert.equal(a.payload.meta.source.template, 'SB GP APS mapping v2');
  const by = Object.fromEntries(a.payload.orders.map(x => [x.orderKey, x.status]));
  assert.deepEqual(by, { 3001: 'split_cost_unverified', 3002: 'split_unmatched' }, '3001 matched by service, waiting for the owning version’s rows; 3002 ambiguous');
  assert.deepEqual(a.needRows, [['2026-09-25', '3001']]);
  // With the owning report version's rows, 3001 is costed from exactly those rows; 3002 stays excluded.
  const vid = 'scr_' + 'a'.repeat(20);
  const b = prepareExport('shipstation_aps_mapping', text, { ...o, scrRows,
    rowsFor: (d, k) => (k === '3001' ? { versionId: vid, rows: [{ service: 'GA', cents: 500 }, { service: 'Ground', cents: 900 }] } : null) });
  const b1 = b.payload.orders.find(x => x.orderKey === '3001');
  assert.deepEqual([b1.status, b1.apsCostCents, b1.scrPins], ['split_matched', 500, [['2026-09-25', 2, 1400, 1, 500, vid]]]);
  assert.equal(b.payload.orders.find(x => x.orderKey === '3002').status, 'split_unmatched');
  // The first format (no ServiceCode) is still accepted; then the same date cannot be told apart (no cost).
  const v1cols = APS_MAPPING_COLUMNS.filter(c => c !== 'ServiceCode');
  const c = prepareExport('shipstation_aps_mapping', toCsvText([row('T1', '3001', 'AS-TILL-1', '9/25/2026'), row('T2', '3001', 'S2KY1048', '9/25/2026')], v1cols), { ...o, scrRows });
  assert.deepEqual([c.facts.format, c.payload.orders[0].status], ['SB GP APS mapping', 'split_unmatched']);
  // Any other column set is refused.
  assert.equal(prepareExport('shipstation_aps_mapping', toCsvText([{ ...r2('T1', '3001', 'AS-TILL-1', 'GA'), Carrier: 'UPS' }], [...APS_MAPPING_COLUMNS, 'Carrier']), o).refused, 'refused_customer_columns');
});
