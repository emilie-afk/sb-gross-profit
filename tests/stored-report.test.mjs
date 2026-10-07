/**
 * Automatic reports from stored results (js/storedReport.js + GET /v1/snapshot/:week/report-part/:k):
 * the shared report screens and the monthly view read stored order and line rows, never an upload.
 *  - A week summed from its stored rows equals the week's stored, verified totals and breakdowns.
 *  - A calendar month counts the orders dated inside it: weeks crossing the boundary are split, whole
 *    weekly totals are never added and margins are recomputed from the month's amounts.
 *  - One revision per week (the latest published); gaps and partial periods are disclosed;
 *    nothing before the earliest reporting week is counted.
 *  - The part route is bounded, published-only for readers and pins the revision a report started from.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dataset, freeTierRun, api, ok } from '../worker/test/freeTierHarness.mjs';
import * as SR from '../js/storedReport.js';
import { ORDERS_PER_PART } from '../shared/resultParts.js';
import { refundIndex, refundSummary, matchesRefundFilter } from '../js/refunds.js';
import { isNegativeText, disclosureHint } from '../js/shell.js';
import { shopifyRows } from './fixtures-free-tier.mjs';
import { toCsvText } from '../shared/adapters/shopifyCsv.js';
import { parseCSV, calculate } from '../shared/calculator.js';
import { engineArgsFromCatalog } from '../shared/catalog.js';

const Q = '?includeDrafts=1';
async function weekRows(env, w) {
  const head = (await api(env, 'GET', `/v1/snapshot/${w}${Q}`)).json;
  const parts = [];
  for (let k = 0; ; k++) {
    const r = await api(env, 'GET', `/v1/snapshot/${w}/report-part/${k}${Q}&snapshot=${head.snapshotId}`);
    assert.equal(r.status, 200, r.text);
    parts.push(r.json);
    if (k + 1 >= r.json.parts) break;
  }
  return { weekStart: w, snapshotId: head.snapshotId, revision: head.revision, head,
    orders: parts.flatMap(p => p.o.orders), lines: parts.flatMap(p => p.l.lines), skuVendors: parts[0].skuVendors, parts };
}
const EARLY = { earliest: '2000-01-03' };              // fixture weeks are in 2020: the production cut-off is tested separately

let run, rows, data;
test('setup: a Free-tier run with several stored weeks', { timeout: 300_000 }, async () => {
  data = dataset({ n: 360 });
  run = await freeTierRun(data, { verify: false });
  rows = [];
  for (const r of run.results.filter(x => x.status === 'computed')) rows.push(await weekRows(run.env, r.weekStart));
  assert.ok(rows.length >= 4, `weeks: ${rows.length}`);
});

test('a week summed from its stored rows equals its stored totals and breakdowns (every field shown)', () => {
  for (const w of rows) {
    const t = w.head.totals;
    const a = SR.aggregate([w], SR.weekRange(w.weekStart), EARLY);
    for (const k of ['operatingRevenue', 'shopifyNetRevenueInclPassThrough', 'routeCollected', 'knownProductCogs', 'knownCostProductRevenue',
                     'knownCostProductGp', 'knownCostProductMargin', 'missingCostRevenue', 'missingCostLines', 'missingCostUnits',
                     'costCoverageByRevenue', 'costCoverageByUnits', 'shippingCollected', 'shippingExpense', 'shipStationExpense',
                     'hpdShippingExpense', 'operatingGpAfterShipping', 'operatingGpMargin', 'ordersRequiringShipStationRate',
                     'ordersWithValidShipStationRate', 'shipStationExpenseCoverage', 'hpdOrdersPassThrough', 'profitabilityStatus'])
      assert.deepEqual(a.totals[k], t[k], `${w.weekStart} ${k}`);
    for (const dim of ['channel', 'vendor', 'store']) {
      const want = Object.fromEntries((w.head.breakdowns[dim] || []).map(b => [b.key, [b.units, b.knownCostRevenue, b.knownCogs, b.knownCostGp, b.knownCostMargin, b.missingCostRevenue, b.missingCostLines]]));
      const got = Object.fromEntries(a.breakdowns[dim].map(b => [b.key, [b.units, b.knownCostRevenue, b.knownCogs, b.knownCostGp, b.knownCostMargin, b.missingCostRevenue, b.missingCostLines]]));
      assert.deepEqual(got, want, `${w.weekStart} ${dim}`);
    }
    assert.equal(a.totals.orders, w.orders.length);
  }
});

test('stored lines feed the shared screens: order-level amounts once per order, missing costs never $0', () => {
  for (const w of rows) {
    const L = SR.storedLines(w.orders, w.lines);
    assert.equal(L.length, w.lines.length);
    const firsts = L.filter(l => l.orderTotal !== 0 || l.shipCollected !== null);
    assert.ok(new Set(firsts.map(l => l.orderNum)).size === firsts.length, 'order amounts sit on one line per order');
    const sumC = f => Math.round(L.reduce((s, l) => s + Math.round((l[f] || 0) * 100), 0)) / 100;
    assert.equal(sumC('orderTotal'), w.head.totals.shopifyNetRevenueInclPassThrough);
    assert.equal(sumC('shipPaid'), w.head.totals.shippingExpense);
    assert.equal(sumC('shipCollected'), w.head.totals.shippingCollected);
    const product = L.filter(l => l.isProductLine);
    assert.equal(Math.round(product.reduce((s, l) => s + Math.round(l.lineRevenue * 100), 0)) / 100,
      Math.round((w.head.totals.knownCostProductRevenue + w.head.totals.missingCostRevenue) * 100) / 100);
    for (const l of product.filter(x => x.costSource === 'COST MISSING')) assert.deepEqual([l.lineCogs, l.lineGp, l.lineNetGp], [null, null, null]);
    const gp = product.filter(l => l.lineGp !== null).reduce((s, l) => s + Math.round(l.lineGp * 100), 0) / 100;
    assert.equal(Math.round(gp * 100) / 100, w.head.totals.knownCostProductGp);
  }
});

test('a calendar month: orders by their own date, boundary weeks split, margin recomputed (never summed or averaged)', () => {
  const all = rows.flatMap(w => w.orders.map(o => ({ ...o, _w: w.weekStart })));
  const months = [...new Set(all.map(o => o.business_date.slice(0, 7)))].sort();
  assert.ok(months.length >= 2, `fixture spans ${months}`);
  const weekList = rows.map(w => ({ weekStart: w.weekStart, revisions: [{ revision: w.revision, status: 'published' }] }));
  let splitSeen = false;
  for (const m of months) {
    const plan = SR.periodPlan('month', m, weekList, EARLY);
    const used = rows.filter(w => plan.weeks.some(p => p.weekStart === w.weekStart));
    const a = SR.aggregate(used, plan.period, EARLY);
    const mine = all.filter(o => o.business_date.startsWith(m));
    const cents = f => mine.reduce((s, o) => s + Math.round((o[f] || 0) * 100), 0);
    assert.equal(a.totals.orders, mine.length, m);
    assert.equal(Math.round(a.totals.operatingRevenue * 100), cents('operating_revenue'), `${m} revenue`);
    assert.equal(Math.round(a.totals.knownProductCogs * 100), cents('known_product_cogs'), `${m} cogs`);
    assert.equal(Math.round(a.totals.shippingExpense * 100), cents('ship_paid'), `${m} shipping`);
    const gp = cents('operating_revenue') - cents('known_product_cogs') - cents('ship_paid');
    assert.equal(Math.round(a.totals.operatingGpAfterShipping * 100), gp, `${m} GP`);
    assert.equal(a.totals.operatingGpMargin, Math.round(gp / cents('operating_revenue') * 1000) / 10, `${m} margin from the month's amounts`);
    // A boundary week is split: its weekly totals are not added whole.
    const boundary = used.filter(w => w.orders.some(o => !o.business_date.startsWith(m)));
    if (boundary.length) {
      splitSeen = true;
      const naive = used.reduce((s, w) => s + Math.round(w.head.totals.operatingRevenue * 100), 0);
      assert.notEqual(Math.round(a.totals.operatingRevenue * 100), naive, `${m}: not the sum of whole weeks`);
      const avg = used.reduce((s, w) => s + w.head.totals.operatingGpMargin, 0) / used.length;
      assert.ok(Math.abs(a.totals.operatingGpMargin - avg) > 1e-9 || used.length === 1, 'not an average of weekly margins');
      assert.ok(SR.disclosures({ plan, totals: a.totals }).items.some(i => i.kind === 'split_weeks'));
    }
  }
  assert.ok(splitSeen, 'the fixture has a week crossing a month boundary');
  // Months add up: every order is in exactly one month.
  const plans = months.map(m => SR.aggregate(rows.filter(w => SR.periodPlan('month', m, weekList, EARLY).weeks.some(p => p.weekStart === w.weekStart)), SR.monthRange(m), EARLY));
  assert.equal(plans.reduce((s, a) => s + a.totals.orders, 0), all.length);
  assert.equal(plans.reduce((s, a) => s + Math.round(a.totals.operatingRevenue * 100), 0), all.reduce((s, o) => s + Math.round(o.operating_revenue * 100), 0));
});

test('one revision per week; missing and held weeks disclosed; a partial month is never complete', () => {
  const w = rows[0];
  assert.throws(() => SR.aggregate([w, { ...w, revision: w.revision - 1 }], SR.weekRange(w.weekStart), EARLY), /given twice/);
  // The plan keeps the latest published revision; superseded revisions are never listed.
  const plan = SR.periodPlan('month', '2026-09', [
    { weekStart: '2026-08-31', revisions: [{ revision: 3, status: 'published' }, { revision: 2, status: 'superseded' }] },
    { weekStart: '2026-09-07', revisions: [{ revision: 4, status: 'published' }] },
    { weekStart: '2026-09-14', revisions: [{ revision: 4, status: 'published' }] },
    { weekStart: '2026-09-21', revisions: [{ revision: 5, status: 'published' }] },
    { weekStart: '2026-09-28', revisions: [{ revision: 2, status: 'blocked' }] },
  ]);
  assert.deepEqual(plan.weeks.map(x => [x.weekStart, x.published.revision, x.days]), [
    ['2026-08-31', 3, { from: '2026-09-01', to: '2026-09-06' }], ['2026-09-07', 4, { from: '2026-09-07', to: '2026-09-13' }],
    ['2026-09-14', 4, { from: '2026-09-14', to: '2026-09-20' }], ['2026-09-21', 5, { from: '2026-09-21', to: '2026-09-27' }]]);
  assert.deepEqual(plan.gaps, [{ from: '2026-09-28', to: '2026-09-30', weekStart: '2026-09-28', reason: 'not_published' }]);
  const d = SR.disclosures({ plan, totals: { profitabilityStatus: 'complete', ordersRequiringShipStationRate: 10, ordersWithValidShipStationRate: 10, missingCostLines: 0 },
    weekInfo: plan.weeks.map(x => ({ weekStart: x.weekStart, revision: x.published.revision, verification: 'verified' })) });
  assert.equal(d.complete, false);
  assert.equal(d.provisional, true);
  assert.equal(d.status, 'Partial month');
  assert.equal(d.headline, 'Provisional operating GP after shipping');
  assert.ok(d.items.some(i => i.kind === 'not_published' && /Sep 28–Sep 30/.test(i.text)));
  assert.ok(d.items.some(i => i.kind === 'partial_period' && /27 of 30 days/.test(i.text)));
});

test('GP before the earliest reporting week is never counted: August starts on Aug 3, July is not offered', () => {
  const list = [{ weekStart: '2026-07-27', revisions: [{ revision: 1, status: 'published' }] },   // even if a week were published
                { weekStart: '2026-08-03', revisions: [{ revision: 4, status: 'published' }] }];
  assert.deepEqual(SR.monthsOf(list), ['2026-08']);
  const plan = SR.periodPlan('month', '2026-08', list);
  assert.deepEqual(plan.weeks.map(w => w.weekStart), ['2026-08-03']);
  assert.deepEqual(plan.gaps[0], { from: '2026-08-01', to: '2026-08-02', weekStart: '2026-07-27', reason: 'before_reporting' });
  const o = (name, date, rev) => ({ order_name: name, business_date: date, operating_revenue: rev, shopify_net_revenue: rev, route_collected: 0,
    known_product_cogs: 1, ship_collected: 0, ship_paid: 1, ship_paid_ss: 1, ship_paid_hp: 0, requires_ss_rate: 1, has_valid_ss_rate: 1 });
  const a = SR.aggregate([{ weekStart: '2026-07-27', orders: [o('1', '2026-08-01', 50), o('2', '2026-08-02', 60)], lines: [] },
                          { weekStart: '2026-08-03', orders: [o('3', '2026-08-03', 70)], lines: [] }], SR.monthRange('2026-08'));
  assert.deepEqual([a.totals.orders, a.totals.operatingRevenue, a.totals.operatingGpAfterShipping], [1, 70, 68]);
  assert.match(SR.disclosures({ plan, totals: a.totals }).items.find(i => i.kind === 'before_reporting').text, /Aug 1–Aug 2 not included: GP is not reported before Aug 3/);
});

test('report-part route: bounded parts, published only for readers, pinned revision, unknown part', async () => {
  const env = run.env, w = rows[0];
  for (const p of w.parts) assert.ok(p.o.orders.length <= ORDERS_PER_PART && p.o.orders.length > 0);
  assert.equal(w.parts.length, Math.ceil(w.orders.length / ORDERS_PER_PART));
  assert.equal(new Set(w.orders.map(o => o.order_name)).size, w.orders.length, 'every order once');
  const stale = await api(env, 'GET', `/v1/snapshot/${w.weekStart}/report-part/0${Q}&snapshot=snp_00000000000000000000`);
  assert.deepEqual([stale.status, stale.json.error], [409, 'snapshot_changed']);
  const beyond = await api(env, 'GET', `/v1/snapshot/${w.weekStart}/report-part/${w.parts.length}${Q}`);
  assert.deepEqual([beyond.status, beyond.json.error], [404, 'part_unknown']);
  // Readers (session or dashboard reader) see published weeks only: these weeks are drafts.
  const asReader = await api(env, 'GET', `/v1/snapshot/${w.weekStart}/report-part/0`, undefined, 'none');
  assert.equal(asReader.status, 401);
  const noDrafts = await api(env, 'GET', `/v1/snapshot/${w.weekStart}/report-part/0`);       // admin without includeDrafts: published only
  assert.deepEqual([noDrafts.status, noDrafts.json.error], [404, 'week_unknown']);
});

// ─── Refunds (js/refunds.js): already in the figures, read and grouped, never subtracted again ─────

test('refunds from stored weeks: per-order amounts are the stored line shares; filters partition the orders; totals unchanged', () => {
  let seen = 0;
  for (const w of rows) {
    const L = SR.storedLines(w.orders, w.lines, w.skuVendors);
    const idx = refundIndex(L);
    const lineTotal = w.lines.reduce((s, l) => s + Math.round((l.refund_allocated || 0) * 100), 0);
    const s = refundSummary(idx, L);
    assert.equal(Math.round(s.totalRefunded * 100), lineTotal, `${w.weekStart} total refunded = stored line refunds`);
    seen += s.refundedOrders;
    // All orders = refunded + without refunds + unknown; no order in two groups.
    const st = [...idx.values()].map(o => o.status);
    assert.equal(st.filter(x => matchesRefundFilter(x, 'refunded')).length + st.filter(x => matchesRefundFilter(x, 'none')).length + s.unknown, idx.size);
    assert.ok(st.every(x => !(matchesRefundFilter(x, 'refunded') && matchesRefundFilter(x, 'none'))));
    // Per order: net revenue and GP are the stored order amounts (refunds already in them).
    for (const o of w.orders) {
      const r = idx.get(o.order_name);
      if (!r) continue;
      assert.equal(r.netRevenue, o.operating_revenue); assert.equal(r.gp, o.operating_gp);
    }
    // The report's totals do not depend on the filter: they come from the period aggregate.
    assert.equal(SR.aggregate([w], SR.weekRange(w.weekStart), EARLY).totals.operatingRevenue, w.head.totals.operatingRevenue);
  }
  assert.ok(seen > 0, 'the fixture has refunded orders');
});

test('refunds: the CSV report and the automatic reports give the same refunded orders and amounts for the same orders', () => {
  const days = (Date.parse(data.win.to) - Date.parse(data.win.from)) / 864e5 + 1;
  const { rows: csvRows } = shopifyRows({ n: 360, from: data.win.from, days, prefix: '7' });
  const parsed = parseCSV(toCsvText(csvRows, Object.keys(csvRows[0])));
  const a = engineArgsFromCatalog(data.catalog);
  const csvLines = calculate(parsed, new Map(), a.mcgCosts, a.productCosts, a.skuWeights, a.additionalCosts, a.hpByName, a.skuAlias, null, a.mcgExtra,
    a.vendorCosts, a.vendorIndex, { mcgPackCosts: a.mcgPackCosts });
  const csv = refundIndex(csvLines, { refundKnown: true });
  const stored = new Map();
  for (const w of rows) for (const [k, v] of refundIndex(SR.storedLines(w.orders, w.lines, w.skuVendors))) stored.set(k, v);
  const refundedCsv = [...csv.values()].filter(o => matchesRefundFilter(o.status, 'refunded') && stored.has(o.orderNum));
  assert.ok(refundedCsv.length > 0);
  for (const o of refundedCsv) {
    const s = stored.get(o.orderNum);
    assert.deepEqual([s.status, s.refund], [o.status, o.refund], o.orderNum);
  }
  const storedRefunded = [...stored.values()].filter(o => matchesRefundFilter(o.status, 'refunded'));
  assert.equal(storedRefunded.length, refundedCsv.length, 'same refunded orders');
  // A CSV export without the Refunded Amount column: refund status unknown, never "without refunds".
  const none = refundIndex(csvLines.map(l => ({ ...l, orderRefund: undefined, refundAllocated: 0 })), { refundKnown: false });
  assert.ok([...none.values()].every(o => o.status === 'unknown' && !matchesRefundFilter(o.status, 'none')));
});

test('refunds: full versus partial, unknown status, amounts beyond product revenue', () => {
  const L = (orderNum, o) => ({ orderNum, date: '2026-08-04', source: 'web', vendor: 'V', lineRevenue: 0, lineCogs: 2, lineNetGp: -2, shipCollected: null, orderTotal: 0, ...o });
  const idx = refundIndex([
    L('#1', { orderTotal: 0, orderRefund: 20, refundAllocated: 14, lineRevenue: 0, shipCollected: 6, shipPaid: 5 }),   // everything refunded (incl. shipping)
    L('#2', { orderTotal: 10, orderRefund: 5, refundAllocated: 5, lineRevenue: 10, shipCollected: 0, shipPaid: 4 }),   // partial
    L('#3', { orderTotal: 12, orderRefund: undefined, refundAllocated: 0, lineRevenue: 12, shipCollected: 0 }),          // none
  ]);
  assert.deepEqual([...idx.values()].map(o => [o.orderNum, o.status, o.refund]), [['#1', 'full', 20], ['#2', 'partial', 5], ['#3', 'none', 0]]);
  const s = refundSummary(idx, [...idx.keys()].map(k => ({ orderNum: k, vendor: 'V', refundAllocated: k === '#1' ? 14 : k === '#2' ? 5 : 0 })));
  assert.deepEqual([s.refundedOrders, s.fullRefunds, s.partialRefunds, s.totalRefunded, s.refundedPct], [2, 1, 1, 25, 66.7]);
  // $6 of #1's refund is beyond its line shares (shipping): shown, but not given to a vendor.
  assert.deepEqual(s.byVendor.map(v => [v.key, v.amount]), [['V', 19], ['Not attributed to a vendor (shipping, other)', 6]]);
  assert.deepEqual([s.retainedProductCost, s.retainedShippingCost], [4, 9]);
  // Stored: a week that refunded money beyond product revenue makes a zero-product order's status unknown.
  const o = { order_name: 'Z1', business_date: '2026-08-04', shopify_net_revenue: 0, operating_revenue: 0, ship_collected: 0, ship_paid: 0, operating_gp: 0 };
  const lines = [{ order_name: 'Z1', line_index: 0, contract_revenue: 0, line_cogs: 0, refund_allocated: 0, flags: '{"isProductLine":false}' }];
  assert.equal(refundIndex(SR.storedLines([o], lines, {}, { refundsNotPerOrder: 7.5 })).get('Z1').status, 'unknown');
  assert.equal(refundIndex(SR.storedLines([o], lines, {}, { refundsNotPerOrder: 0 })).get('Z1').status, 'none');
});

test('negative amounts and percentages are recognised for red display; the minus sign stays', () => {
  for (const t of ['-$12.30', '−$1,176.97', '-4.1%', '−113.7%', '~-$3.00', '-$0.01']) assert.ok(isNegativeText(t), t);
  for (const t of ['$12.30', '4.1%', '—', '-', 'Week of -', '2026-08-03', '−$', '-1 day ago']) assert.ok(!isNegativeText(t), t);
});

test('refunds beyond order lines: allocated per order, the rest once per week; a boundary week\'s rest is assigned to neither month', { timeout: 300_000 }, async () => {
  // Two orders refunded in full INCLUDING shipping (beyond their product lines): one in a week inside
  // February 2020, one in the week of Feb 24 that crosses into March. No Route line on either.
  const picked = {};
  let exportRows = null;
  const hook = (rows, meta) => {
    exportRows = rows;
    for (const [label, week] of [['inside', '2020-02-10'], ['boundary', '2020-02-24']]) {
      const o = meta.find(m => m.day >= week && m.day <= SR.addDays(week, 6) && m.k % 5 !== 0 && m.k % 37 !== 0 && m.k % 101 !== 0 && m.k % 11 !== 0);
      const first = rows.find(r => r.Name === o.name && r.Subtotal !== '');
      first['Refunded Amount'] = String(+(Number(first.Subtotal) + Number(first.Shipping)).toFixed(2));
      picked[label] = { name: o.name, week, refund: Number(first['Refunded Amount']), shipping: Number(first.Shipping) };
    }
  };
  const d = dataset({ n: 360, rowsHook: hook });
  const r = await freeTierRun(d, { verify: false });
  const weeks = [];
  for (const x of r.results.filter(y => y.status === 'computed')) weeks.push(await weekRows(r.env, x.weekStart));
  const wk = w => weeks.find(x => x.weekStart === w);
  for (const p of Object.values(picked)) {
    const w = wk(p.week);
    const idx = refundIndex(SR.storedLines(w.orders, w.lines, w.skuVendors));
    const o = idx.get(p.name);
    assert.equal(o.status, 'full');
    assert.equal(Math.round(o.refund * 100), Math.round((p.refund - p.shipping) * 100), 'per order: the allocated (line) refund');
    assert.ok(w.head.revenueBridge.components.refundsBeyondProductRevenue >= p.shipping - 0.005, 'the week keeps the rest');
    // A week report: allocated + the week's rest = the export's refunds for those orders (complete).
    const a = SR.aggregate([w], SR.weekRange(w.weekStart), EARLY);
    const s = refundSummary(idx, SR.storedLines(w.orders, w.lines, w.skuVendors), { notPerOrder: a.refunds });
    assert.equal(s.complete, true);
    assert.equal(Math.round(s.totalRefunded * 100), Math.round((s.allocatedRefunded + w.head.revenueBridge.components.refundsBeyondProductRevenue) * 100));
    assert.equal(s.basis, 'allocated');
  }
  // The CSV report of the same export: complete refund per order; per week, its total equals the stored
  // allocated refunds plus the week's refunds beyond order lines.
  const a0 = engineArgsFromCatalog(d.catalog);
  const csvLines = calculate(parseCSV(toCsvText(exportRows, Object.keys(exportRows[0]))), new Map(), a0.mcgCosts, a0.productCosts, a0.skuWeights,
    a0.additionalCosts, a0.hpByName, a0.skuAlias, null, a0.mcgExtra, a0.vendorCosts, a0.vendorIndex, { mcgPackCosts: a0.mcgPackCosts });
  const csv = refundIndex(csvLines, { refundKnown: true });
  for (const p of Object.values(picked)) assert.equal(csv.get(p.name).refund, p.refund, 'CSV: the complete refund (product + shipping)');
  for (const p of Object.values(picked)) {
    const w = wk(p.week), names = new Set(w.orders.map(o => o.order_name));
    const csvWeek = [...csv.values()].filter(o => names.has(o.orderNum)).reduce((t, o) => t + Math.round(o.refund * 100), 0);
    const a = SR.aggregate([w], SR.weekRange(w.weekStart), EARLY);
    assert.equal(Math.round(a.refunds.total * 100), csvWeek, `${p.week}: stored allocated + rest = the CSV's refunds`);
  }
  // February: the inside week's rest counts; the boundary week's rest is listed, not counted.
  const weekList = weeks.map(w => ({ weekStart: w.weekStart, revisions: [{ revision: w.revision, status: 'published' }] }));
  const totals = {};
  for (const m of ['2020-02', '2020-03']) {
    const plan = SR.periodPlan('month', m, weekList, EARLY);
    const used = weeks.filter(w => plan.weeks.some(p => p.weekStart === w.weekStart));
    const a = SR.aggregate(used, plan.period, EARLY);
    const lines = used.flatMap(w => { const os = w.orders.filter(o => o.business_date.startsWith(m)); const n = new Set(os.map(o => o.order_name));
      return SR.storedLines(os, w.lines.filter(l => n.has(l.order_name)), w.skuVendors); });
    const s = refundSummary(refundIndex(lines), lines, { notPerOrder: a.refunds });
    totals[m] = { s, a };
    assert.equal(s.complete, false, `${m}: a boundary week has refunds not assigned to a month`);
    assert.deepEqual(s.boundaryNotAssigned.map(b => b.weekStart), ['2020-02-24']);
    assert.equal(Math.round(s.totalRefunded * 100), Math.round((s.allocatedRefunded + s.notAllocatedToOrders) * 100));
  }
  const beyond = w => Math.round(wk(w).head.revenueBridge.components.refundsBeyondProductRevenue * 100);
  assert.ok(beyond('2020-02-24') > 0 && beyond('2020-02-10') > 0);
  assert.equal(Math.round(totals['2020-02'].s.notAllocatedToOrders * 100), weeks.filter(w => w.weekStart >= '2020-02-03' && w.weekStart <= '2020-02-17').reduce((t, w) => t + beyond(w.weekStart), 0),
    'February counts the rest of the weeks wholly inside it, and not the boundary week');
  assert.ok(!totals['2020-03'].s.notAllocatedToOrders || weeks.filter(w => w.weekStart >= '2020-03-02').some(w => beyond(w.weekStart) > 0), 'March does not take the Feb 24 week\'s rest');
});

test('missing costs: the headline operating GP keeps the approved formula and says it can be overstated', () => {
  // A $100 order whose only line has no known cost: operating GP $100 (no cost deducted), product GP $0.
  const o = { order_name: 'M1', business_date: '2026-08-04', operating_revenue: 100, shopify_net_revenue: 100, route_collected: 0, known_product_cogs: 0,
    ship_collected: 0, ship_paid: 0, ship_paid_ss: 0, ship_paid_hp: 0, requires_ss_rate: 0, has_valid_ss_rate: 0 };
  const l = { order_name: 'M1', line_index: 0, contract_revenue: 100, line_cogs: null, missing_cost: 1, qty: 1, flags: '{"isProductLine":true}', channel: 'web', store: 'S' };
  const a = SR.aggregate([{ weekStart: '2026-08-03', orders: [o], lines: [l] }], SR.weekRange('2026-08-03'));
  assert.deepEqual([a.totals.operatingGpAfterShipping, a.totals.knownCostProductGp, a.totals.missingCostRevenue], [100, 0, 100]);
  const d = SR.disclosures({ plan: SR.periodPlan('week', '2026-08-03', [{ weekStart: '2026-08-03', revisions: [{ revision: 1, status: 'published' }] }]), totals: a.totals });
  const text = d.items.find(i => i.kind === 'missing_cost').text;
  assert.match(text, /Operating GP includes that revenue but deducts no cost for it, so it is overstated/);
  assert.doesNotMatch(text, /left out of (product )?GP|never counted at \$0/);
});

test('collapsed Provisional result card: the hint counts notes and those needing attention', () => {
  assert.equal(disclosureHint(0), 'Show details');
  assert.equal(disclosureHint(1), 'Show 1 note');
  assert.equal(disclosureHint(7, 0), 'Show 7 notes');
  assert.equal(disclosureHint(7, 1), 'Show 7 notes (1 needs attention)');
  assert.equal(disclosureHint(7, 3), 'Show 7 notes (3 need attention)');
});

test('switching saved reports: neighbours and the full list of published months and weeks', async () => {
  const SRm = await import('../js/storedReport.js');
  const pub = w => ({ weekStart: w, revisions: [{ revision: 1, status: 'published' }] });
  const held = w => ({ weekStart: w, revisions: [{ revision: 1, status: 'blocked' }] });
  const list = ['2026-07-27', '2026-08-03', '2026-08-10', '2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21'].map(pub)
    .concat([held('2026-08-17'), held('2026-09-28'), pub('2026-07-20')]);
  // Weeks: published, holding days from Aug 3 on (Jul 27 week ends Aug 2: excluded), newest first.
  assert.deepEqual(SRm.weeksOf(list), ['2026-09-21', '2026-09-14', '2026-09-07', '2026-08-31', '2026-08-24', '2026-08-10', '2026-08-03']);
  assert.deepEqual(SRm.monthsOf(list), ['2026-09', '2026-08']);
  // August ↔ September, both ways; nothing before August or after September.
  assert.equal(SRm.adjacentPeriod('month', '2026-08', list, 1), '2026-09');
  assert.equal(SRm.adjacentPeriod('month', '2026-09', list, -1), '2026-08');
  assert.equal(SRm.adjacentPeriod('month', '2026-08', list, -1), null);
  assert.equal(SRm.adjacentPeriod('month', '2026-09', list, 1), null);
  // Weeks skip the held week of Aug 17.
  assert.equal(SRm.adjacentPeriod('week', '2026-08-10', list, 1), '2026-08-24');
  assert.equal(SRm.adjacentPeriod('week', '2026-08-24', list, -1), '2026-08-10');
});
