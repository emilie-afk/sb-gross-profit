/**
 * subscriptionPl.js — Subscription P&L per delivery, by exact SKU or by subscription type (Order detail → Subscriptions)
 * ======================================================================================================================
 * Pure, dashboard only. Reads calculator-shape line items (CSV uploads, and saved reports through
 * storedReport.storedLines, which carry the same subscription fields), so both give the same table.
 *
 * Per group (all subscription lines: SKU starting SUB or GSUB):
 *   deliveries   every subscription line (each is one box shipped)
 *   paid         lines with revenue (a new or prepaid order); renewals: the rest (a prepaid month, $0 revenue)
 *   price        average monthly price over paid lines: revenue ÷ the SKU's months
 *   cogs         average product cost per delivery, KNOWN costs only (a missing cost is counted, never $0)
 *   ss           average ShipStation label cost per delivery (lines whose label cost is in)
 *   shipColl     average shipping the CUSTOMER PAID US per month of the plan, over paid lines
 *   expShip      the expected monthly shipping fee for the SKU
 *   shipNet      shipColl − ss: what shipping leaves us per month. Negative = we lose money on shipping
 *                (the dashboard's sign rule: a negative figure, shown red, is money lost)
 *   gp           price − cogs (per month);  gpPct = gp ÷ price
 *   netGp        gp − ss + shipColl;  netGpPct = netGp ÷ (price + shipColl)
 *   unsplit      deliveries in orders with several subscriptions (shipping not split: left out of ss and shipColl)
 *   missingCost  deliveries without a known product cost (left out of cogs)
 * A value that cannot be worked out is null (shown as —), never 0.
 */

export const isSubSku = sku => /^(SUB|GSUB)/i.test(sku || '');

/** "2 succs/mo + clay pot (gift)" from a subscription SKU (the plants are the second-to-last number). */
export function subTypeName(sku) {
  const s = String(sku || '').toUpperCase();
  const isGift = s.startsWith('GSUB');
  const hasPot = s.includes('POT') || s.includes('UPGRADE');
  const nums = s.split('-').map(p => parseInt(p, 10)).filter(n => !isNaN(n) && n > 0 && n <= 50);
  const plants = nums.length >= 2 ? nums[nums.length - 2] : (nums[0] || 1);
  return `${plants === 1 ? '1 succ' : `${plants} succs`}/mo${hasPot ? ' + clay pot' : ''}${isGift ? ' (gift)' : ''}`;
}

const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const r2 = v => (v === null || v === undefined || Number.isNaN(v) ? null : Math.round(v * 100) / 100);
const pct = (a, b) => (a !== null && b ? Math.round(a / b * 1000) / 10 : null);
const num = v => (v === null || v === undefined ? null : Number(v));

function newGroup(key, extra) {
  return { key, ...extra, deliveries: 0, paid: 0, renewals: 0, orders: new Set(), products: new Map(), months: new Set(),
           rev: [], cogs: [], ss: [], ship: [], exp: null, unsplit: 0, missingCost: 0 };
}
function add(g, l) {
  g.deliveries++;
  g.orders.add(l.orderNum);
  if (l.product) g.products.set(l.product, (g.products.get(l.product) || 0) + 1);
  if (l.subMonths) g.months.add(Number(l.subMonths));
  const rev = num(l.lineRevenue) || 0;
  const paid = rev > 0 && l.subMonths;
  if (paid) { g.paid++; g.rev.push(rev / l.subMonths); if (!l.subShipUnavailable && num(l.subShipMo) !== null) g.ship.push(num(l.subShipMo)); }
  else g.renewals++;
  if (l.lineCogs === null || l.lineCogs === undefined) g.missingCost++; else g.cogs.push(Number(l.lineCogs));
  if (l.subShipUnavailable) g.unsplit++;
  else if (num(l.subSSCostMo) !== null) g.ss.push(num(l.subSSCostMo));
  if (g.exp === null && num(l.expSubShipMo) !== null) g.exp = num(l.expSubShipMo);
}
function finish(g) {
  const price = r2(avg(g.rev)), cogs = r2(avg(g.cogs)), ss = r2(avg(g.ss)), shipColl = r2(avg(g.ship));
  const gp = price !== null && cogs !== null ? r2(price - cogs) : null;
  const netGp = gp !== null && ss !== null && shipColl !== null ? r2(gp - ss + shipColl) : null;
  const product = [...g.products.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const { orders, products, months, rev, cogs: c, ss: s, ship, exp, ...rest } = g;
  return { ...rest, product, months: [...months].sort((a, b) => a - b), orders: orders.size,
           price, cogs, ss, shipColl, expShip: exp, shipNet: ss !== null && shipColl !== null ? r2(shipColl - ss) : null,
           gp, gpPct: pct(gp, price), netGp, netGpPct: pct(netGp, price !== null && shipColl !== null ? price + shipColl : price) };
}

/**
 * @param {object[]} lines   calculator-shape line items (the filtered order table's)
 * @param {{ groupBy?: 'sku'|'type' }} [o]
 * @returns {{ rows: object[], total: object }}  rows sorted by deliveries (most first), then key
 */
export function subscriptionPl(lines, { groupBy = 'sku' } = {}) {
  const groups = new Map(), total = newGroup('total', { label: 'All subscriptions' });
  for (const l of lines || []) {
    if (!isSubSku(l.sku)) continue;
    const sku = String(l.sku).trim().toUpperCase();
    const key = groupBy === 'type' ? subTypeName(sku) : sku;
    if (!groups.has(key)) groups.set(key, newGroup(key, { label: key, type: subTypeName(sku), sku: groupBy === 'sku' ? sku : null }));
    add(groups.get(key), l);
    add(total, l);
  }
  const rows = [...groups.values()].map(finish).sort((a, b) => b.deliveries - a.deliveries || a.key.localeCompare(b.key));
  return { rows, total: finish(total) };
}

const COLS = [['label', 'SKU'], ['type', 'Type'], ['product', 'Product'], ['months', 'Months'], ['deliveries', 'Deliveries'], ['paid', 'Paid orders'],
  ['renewals', 'Renewals'], ['price', 'Avg price/mo'], ['cogs', 'Avg COGS/delivery'], ['ss', 'Avg label cost/delivery'], ['shipColl', 'Avg ship collected/mo'],
  ['expShip', 'Expected ship/mo'], ['shipNet', 'Ship net/mo (collected − label)'], ['gp', 'GP/mo'], ['gpPct', 'GP %'], ['netGp', 'Net GP/mo'], ['netGpPct', 'Net GP %'],
  ['missingCost', 'Missing cost (left out)'], ['unsplit', 'Shipping not split (left out)']];

/** CSV text of a subscriptionPl result (rows then a Total row). */
export function subscriptionPlCsv({ rows, total }, { groupBy = 'sku' } = {}) {
  const cols = groupBy === 'type' ? COLS.filter(([k]) => k !== 'type' && k !== 'product').map(([k, h]) => (k === 'label' ? [k, 'Type'] : [k, h])) : COLS;
  const q = v => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const cell = (r, k) => {
    const v = r[k];
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) return v.join('/');
    if (typeof v === 'number' && ['price', 'cogs', 'ss', 'shipColl', 'expShip', 'shipNet', 'gp', 'netGp'].includes(k)) return v.toFixed(2);
    return v;
  };
  const body = [...rows, { ...total, label: 'Total', type: '', product: '' }].map(r => cols.map(([k]) => q(cell(r, k))).join(','));
  return [cols.map(([, h]) => q(h)).join(','), ...body].join('\n') + '\n';
}
