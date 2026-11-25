/**
 * Subscription P&L per delivery (js/subscriptionPl.js), by exact SKU or by type, for CSV uploads and saved reports.
 * Synthetic lines in the calculator's shape.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { subscriptionPl, subscriptionPlCsv, subTypeName, isSubSku } from '../js/subscriptionPl.js';

let n = 0;
const sub = (sku, o = {}) => ({ orderNum: o.order || `#S${++n}`, sku, product: o.product || `Box ${sku}`, subMonths: o.months ?? 1, lineRevenue: o.revenue ?? 0,
  lineCogs: o.cogs === undefined ? 6 : o.cogs, subShipMo: o.shipMo ?? null, subSSCostMo: o.ss ?? null, expSubShipMo: o.exp ?? 6.99,
  subShipUnavailable: !!o.unsplit });
const LINES = [
  sub('SUB2-1-1', { revenue: 25, shipMo: 6.99, ss: 6.1 }), sub('SUB2-1-1', { revenue: 27, shipMo: 6.99, ss: 5.9 }), sub('SUB2-1-1', { ss: 6.0 }),   // a renewal
  sub('SUB2-1-12', { revenue: 240, months: 12, shipMo: 6.99, ss: 6.4 }), sub('SUB2-1-12', { months: 12, ss: 6.2 }),
  sub('SUB2-1-POT', { revenue: 30, shipMo: 7.99, ss: 9.5, cogs: 9, exp: 7.99 }),
  sub('GSUB3-1-6', { revenue: 120, months: 6, shipMo: 6.99, ss: 7.0, cogs: 9 }),
  { orderNum: '#X', sku: 'MG-ALOE', lineRevenue: 10, lineCogs: 4 },
];

// The type-level maths the Reports screen used before (all costs known here, so known-cost COGS equals it).
function oldTypePl(lines) {
  const types = {};
  for (const l of lines.filter(x => isSubSku(x.sku))) {
    const g = types[subTypeName(l.sku)] ||= { deliveries: 0, rev: [], cogs: [], ss: [], ship: [] };
    g.deliveries++; g.cogs.push(l.lineCogs || 0); if (l.subSSCostMo !== null) g.ss.push(l.subSSCostMo);
    if ((l.lineRevenue || 0) > 0 && l.subMonths) { g.rev.push(l.lineRevenue / l.subMonths); if (l.subShipMo !== null) g.ship.push(l.subShipMo); }
  }
  const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null), r2 = v => (v === null ? null : Math.round(v * 100) / 100);
  return Object.fromEntries(Object.entries(types).map(([t, g]) => {
    const price = r2(avg(g.rev)), cogs = r2(avg(g.cogs)), ss = r2(avg(g.ss)), ship = r2(avg(g.ship));
    const gp = price !== null && cogs !== null ? r2(price - cogs) : null;
    return [t, { deliveries: g.deliveries, price, cogs, ss, shipColl: ship, gp, netGp: gp !== null && ss !== null && ship !== null ? r2(gp - ss + ship) : null }];
  }));
}

test('by type: the same figures as the Reports screen\'s Subscription P&L had', () => {
  const { rows } = subscriptionPl(LINES, { groupBy: 'type' });
  const old = oldTypePl(LINES);
  assert.deepEqual(rows.map(r => r.key).sort(), Object.keys(old).sort());
  for (const r of rows) assert.deepEqual({ deliveries: r.deliveries, price: r.price, cogs: r.cogs, ss: r.ss, shipColl: r.shipColl, gp: r.gp, netGp: r.netGp }, old[r.key], r.key);
});

test('by SKU: exact SKUs, paid orders and renewals, months, product, totals', () => {
  const { rows, total } = subscriptionPl(LINES);
  const by = Object.fromEntries(rows.map(r => [r.key, r]));
  assert.deepEqual(Object.keys(by).sort(), ['GSUB3-1-6', 'SUB2-1-1', 'SUB2-1-12', 'SUB2-1-POT']);
  assert.deepEqual([by['SUB2-1-1'].deliveries, by['SUB2-1-1'].paid, by['SUB2-1-1'].renewals, by['SUB2-1-1'].price], [3, 2, 1, 26]);
  assert.deepEqual([by['SUB2-1-12'].price, by['SUB2-1-12'].months], [20, [12]], 'monthly price of a 12-month plan');
  assert.equal(by['SUB2-1-1'].type, '1 succ/mo', 'the plants are the second-to-last number');
  assert.equal(by['SUB2-1-POT'].type, '1 succ/mo + clay pot');
  assert.equal(by['GSUB3-1-6'].type, '1 succ/mo (gift)'); assert.equal(subTypeName('SUB5-4-12'), '4 succs/mo');
  assert.equal(by['SUB2-1-POT'].expShip, 7.99);
  assert.equal(by['SUB2-1-1'].shipNet, Math.round((by['SUB2-1-1'].shipColl - by['SUB2-1-1'].ss) * 100) / 100, 'collected − label: negative = a loss');
  assert.equal(total.deliveries, 7);
  assert.equal(rows[0].key, 'SUB2-1-1', 'most deliveries first');
});

test('ship net = collected − label: negative when the label costs more than the customer paid (a loss)', () => {
  const by = Object.fromEntries(subscriptionPl(LINES).rows.map(r => [r.key, r]));
  assert.equal(by['SUB2-1-POT'].shipNet, -1.51, 'collected $7.99, label $9.50: we lose $1.51 a month');
  assert.equal(by['SUB2-1-12'].shipNet, 0.69, 'collected $6.99, label $6.30 on average: $0.69 left a month');
  assert.equal(by['GSUB3-1-6'].shipNet, -0.01);
  assert.ok(!('shipLoss' in by['SUB2-1-1']), 'no inverted-sign figure');
  const csv = subscriptionPlCsv(subscriptionPl(LINES)).split('\n');
  assert.match(csv[0], /Ship net\/mo \(collected − label\)/);
  assert.match(csv.find(l => l.startsWith('SUB2-1-POT,')), /,-1\.51,/);
});

test('missing costs and unsplit shipping are left out (counted), never treated as $0', () => {
  const lines = [sub('SUB1-1-1', { revenue: 20, cogs: null, ss: 6, shipMo: 6.99 }), sub('SUB1-1-1', { revenue: 20, cogs: 3, ss: 6, shipMo: 6.99 }),
                 sub('SUB1-1-1', { revenue: 20, cogs: 3, unsplit: true, ss: null, shipMo: null })];
  const [r] = subscriptionPl(lines).rows;
  assert.deepEqual([r.cogs, r.missingCost, r.unsplit, r.ss, r.shipColl], [3, 1, 1, 6, 6.99]);
  const none = subscriptionPl([sub('SUB1-1-1', { revenue: 20, cogs: null })]).rows[0];
  assert.deepEqual([none.cogs, none.gp, none.netGp], [null, null, null]);
});

test('CSV: header, rows and a Total row; by type leaves out the SKU-only columns', () => {
  const csv = subscriptionPlCsv(subscriptionPl(LINES)).trim().split('\n');
  assert.match(csv[0], /^SKU,Type,Product,Months,Deliveries,Paid orders,Renewals,Avg price\/mo/);
  assert.equal(csv.length, 4 + 2);
  assert.match(csv.at(-1), /^Total,/);
  const byType = subscriptionPlCsv(subscriptionPl(LINES, { groupBy: 'type' }), { groupBy: 'type' }).trim().split('\n');
  assert.match(byType[0], /^Type,Months,Deliveries/);
});
