/**
 * Automated weekly reports (js/weeklyReports.js): read-only rendering of what the Worker serves to a
 * signed-in dashboard session. Fakes only; no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWeekList, renderWeek, renderOrders, renderLines, isProvisional, createWeeklyReports, shippingCoverageText, reportFlagsText } from '../js/weeklyReports.js';
import * as client from '../js/workerClient.js';

const week = {
  weekStart: '2026-09-21', revision: 1, status: 'published', profitabilityStatus: 'provisional_missing_costs_and_shipping',
  verification: { status: 'verified' }, narrative: { provisional: true },
  totals: { operatingRevenue: 11009.95, operatingGpAfterShipping: 4698.98, operatingGpMargin: 42.68, knownCostProductGp: 5000, shippingExpense: 900.5,
            ordersRequiringShipStationRate: 100, ordersWithValidShipStationRate: 86,
            labels: { headline: 'Provisional operating GP after shipping', notes: ['Excludes shipping expense on 86 orders <b>x</b>'], costCoverage: 'Incomplete cost coverage' } },
  breakdowns: { channel: [{ key: 'web', units: 10, knownCostRevenue: 100, knownCostGp: 40, knownCostMargin: 0.4, missingCostRevenue: 0 }], vendor: [] },
};

test('weekly reports: the week list shows status, profitability, figures and verification, and explains an empty list', () => {
  const html = renderWeekList([{ weekStart: '2026-09-21', revisions: [{ status: 'published', profitabilityStatus: 'provisional_missing_costs', operatingRevenue: 1234.5, operatingGpAfterShipping: -10, operatingGpMargin: 10, costCoverageByRevenue: 97.5,
    shippingCoverage: { ordersWithCost: 2, ordersRequiringCost: 332 }, partialWeek: { from: '2026-01-01', to: '2026-01-04' }, verification: { status: 'verified' } }] }]);
  for (const s of ['2026-09-21', 'Published', 'Provisional — some product costs missing', '$1,234.50', '−$10.00', '10.0%', '0.6% ⚠', '97.5%', 'partial week (2026-01-01–2026-01-04)', 'Independently verified']) assert.ok(html.includes(s), s);
  assert.match(renderWeekList([]), /No weekly reports are visible yet.*manual uploads remain available/);
  assert.match(renderWeekList([{ weekStart: '<script>' }]), /No weekly reports/, 'a malformed week is not rendered');
});

test('weekly reports: a week keeps its provisional labels and notes, and every value is escaped', () => {
  const html = renderWeek(week);
  for (const s of ['Provisional operating GP after shipping', 'Provisional', '$4,698.98', '$11,009.95', '42.7%', 'Incomplete cost coverage', 'Independently verified']) assert.ok(html.includes(s), s);
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;') && !html.includes('<b>x</b>'));
  assert.equal(isProvisional(week), true);
  assert.equal(isProvisional({ ...week, profitabilityStatus: 'complete', narrative: { provisional: false } }), false);
});

test('weekly reports: orders page and line items', () => {
  const list = { orders: [{ orderName: '#1001', businessDate: '2026-09-21', channel: 'web', operatingRevenue: 25, knownProductCogs: 10, shipPaid: 5, operatingGp: 10, profitabilityStatus: 'provisional_missing_costs' }], page: { offset: 0, limit: 100, total: 150 } };
  const html = renderOrders(list, { week: '2026-09-21', offset: 0 });
  assert.ok(html.includes('Orders 1–1 of 150') && html.includes('Next →') && !html.includes('Previous'));
  const lines = renderLines({ lines: [{ sku: 'MG-1', product: 'Aloe', vendorKey: 'mcg', qty: 2, contractRevenue: 20, lineCogs: 8, knownCostGp: 12, costSource: 'catalog', missingCost: false },
                                     { sku: 'X', product: 'Y', vendorKey: 'v', qty: 1, contractRevenue: 5, lineCogs: 0, knownCostGp: null, costSource: 'none', missingCost: true }] });
  assert.ok(lines.includes('MG-1') && lines.includes('$8.00') && lines.includes('missing'));
});

const fakeRoot = () => {
  const lines = { hidden: true, firstElementChild: { innerHTML: '' } }, orders = { innerHTML: '' };
  return { innerHTML: '', querySelector: sel => (sel === '#auto-orders' ? orders : sel === '#auto-lines-0' ? lines : null), _orders: orders, _lines: lines };
};
const err = status => Object.assign(new Error('x'), { status });

test('weekly reports: no second password — weeks load directly; a week opens with orders and expandable lines', async () => {
  const calls = [];
  const c = {
    weeks: async () => { calls.push('weeks'); return { weeks: [{ weekStart: '2026-09-21', revisions: [{ status: 'published' }] }] }; },
    login: async () => { calls.push('login'); throw new Error('the dashboard never signs in to the Worker'); },
    snapshot: async w => { calls.push(`snapshot ${w}`); return week; },
    orders: async (w, o) => { calls.push(`orders ${w} ${o.offset}`); return { orders: [{ orderName: '#1001' }], page: { total: 1 } }; },
    order: async (w, n) => { calls.push(`order ${n}`); return { lines: [{ sku: 'MG-1' }] }; },
  };
  const root = fakeRoot(), ui = createWeeklyReports(root, c);
  assert.equal(ui.signIn, undefined, 'no sign-in step');
  await ui.load();
  assert.ok(!root.innerHTML.includes('type="password"'));
  assert.ok(root.innerHTML.includes('2026-09-21'));
  await ui.openWeek('2026-09-21');
  assert.ok(root.innerHTML.includes('Provisional operating GP after shipping'));
  assert.ok(root._orders.innerHTML.includes('#1001'));
  await ui.toggleOrder('2026-09-21', 0);
  assert.equal(root._lines.hidden, false);
  assert.ok(root._lines.firstElementChild.innerHTML.includes('MG-1'));
  await ui.openWeek('not-a-week');
  assert.deepEqual(calls, ['weeks', 'snapshot 2026-09-21', 'orders 2026-09-21 0', 'order #1001']);
});

test('weekly reports: a refused read (401) says access is not set up and never shows a password form', async () => {
  const root = fakeRoot(), ui = createWeeklyReports(root, { weeks: async () => { throw err(401); } });
  await ui.load();
  assert.ok(!root.innerHTML.includes('type="password"') && !/password was not accepted/i.test(root.innerHTML));
  assert.ok(root.innerHTML.includes('access to the weekly reports is not set up yet'));
});

test('weekly reports: the client only builds dashboard routes and caps a page at 100 orders', async () => {
  const urls = [];
  const fetchImpl = async u => { urls.push(u); return { ok: true, json: async () => ({}) }; };
  await client.orders('2026-09-21', { offset: 200, limit: 500 }, { fetchImpl });
  await client.order('2026-09-21', '#1001/x', { fetchImpl });
  await client.weekStatus('2026-09-21', { fetchImpl });
  assert.deepEqual(urls, ['/api/v1/snapshot/2026-09-21/orders?offset=200&limit=100&sort=date_asc', '/api/v1/snapshot/2026-09-21/orders/%231001%2Fx', '/api/v1/weeks/2026-09-21/status']);
});

test('weekly reports: coverage disclosures say what is missing (never as $0), the partial week, the pinned catalog and report flags', () => {
  assert.equal(shippingCoverageText({ ordersRequiringShipStationRate: 332, ordersWithValidShipStationRate: 332 }), 'Shipping cost present on all 332 orders that need it.');
  assert.match(shippingCoverageText({ ordersRequiringShipStationRate: 332, ordersWithValidShipStationRate: 2 }), /missing on 330 of 332 orders \(0\.6% covered\).*not counted as \$0.*overstated/);
  assert.equal(shippingCoverageText({ ordersRequiringShipStationRate: 0, ordersWithValidShipStationRate: 0 }), null);
  const html = renderWeek({ ...week, catalog: { freshness: { status: 'reused_accepted' } },
    totals: { ...week.totals, labels: { ...week.totals.labels, partialWeek: { from: '2026-01-01', to: '2026-01-04', reportingStart: '2026-01-01' } } } },
    { sources: { shippingReport: { flags: ['over_review_cap', 'changed_cost'], changedDates: ['2026-09-22'] } } });
  for (const t of ['Coverage and disclosures', 'Partial reporting week: orders from 2026-01-01 to 2026-01-04 only', 'Shipping cost missing on 14 of 100 orders',
                   'cost catalog pinned to this week', 'unusually large shipping rows', 'Late cost corrections on 2026-09-22']) assert.ok(html.includes(t), t);
  assert.equal(reportFlagsText({ sources: { shippingReport: { flags: [], changedDates: [] } } }), null);
});
