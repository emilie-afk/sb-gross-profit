/**
 * Browser regression (Order detail, 2026-11-20):
 *   • Subscription P&L lives in Order detail → Subscriptions (not Reports) and opens on saved reports;
 *   • a Shipping screen table row opens its orders in Order detail → Shipping view, and they add up to that row;
 *   • the shipping-vendor and subscription filters narrow every view; the Shipping view exports a CSV.
 *   npm run test:browser
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { start, PLAYWRIGHT } from './harness.mjs';

const haveBrowser = fs.existsSync(PLAYWRIGHT);
let h, browser;
test.before(async () => { if (!haveBrowser) return; const { chromium } = await import(PLAYWRIGHT); h = await start(); browser = await chromium.launch(); });
test.after(async () => { await browser?.close(); await h?.close(); });

async function openWeek() {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 }, acceptDownloads: true });
  await ctx.addCookies([{ name: '__gp_session', value: h.gateCookie, domain: '127.0.0.1', path: '/' }]);
  const p = await ctx.newPage();
  p.errors = []; p.on('pageerror', e => p.errors.push(String(e)));
  await p.goto(h.url + '/'); await p.click('text=View weekly reports'); await p.waitForSelector('.gp-auto-weeks');
  await p.click('.gp-auto-weeks button:has-text("2026-09-14")');
  await p.waitForSelector('#dashboard', { state: 'visible' });
  await p.waitForFunction(() => !document.getElementById('loading').classList.contains('active'));
  return p;
}
const amount = t => Number(String(t).replace(/[$,\s]/g, '').replace(/^−/, '-'));

test('Subscription P&L: in Order detail → Subscriptions on a saved report, not in Reports', { skip: !haveBrowser && 'Playwright not installed' }, async () => {
  const p = await openWeek();
  await p.evaluate(() => window.gotoScreen('reports'));
  assert.equal(await p.locator('[data-report="subpl"]').count(), 0, 'no Reports tile');
  assert.equal(await p.locator('#view-subpl').count(), 0);
  await p.evaluate(() => window.gotoScreen('orders'));
  await p.click('[data-quick="sub"]');
  await p.waitForSelector('#view-sub', { state: 'visible' });
  assert.ok(await p.locator('#subpl-head th').count() >= 10, 'P&L columns');
  assert.match(await p.locator('#subpl-head').innerText(), /SKU/i);
  // SKU, Type and Product stay in view while the figures scroll sideways.
  const frozen = () => p.$$eval('#subpl-head th', ths => ths.map(th => ({ t: th.textContent.trim(), sticky: getComputedStyle(th).position === 'sticky', left: parseFloat(th.style.left) })).filter(x => x.sticky));
  const three = await frozen();
  assert.deepEqual(three.map(x => x.t.replace(/\s*[▲▼]$/, '')), ['SKU', 'Type', 'Product']);
  assert.equal(three[0].left, 0); assert.ok(three[1].left > 0 && three[2].left > three[1].left, 'side by side');
  await p.setViewportSize({ width: 700, height: 900 });
  await p.$eval('#subpl-table', t => { t.parentElement.scrollLeft = 10000; });
  const box = await p.locator('#subpl-head th').first().boundingBox();
  const wrap = await p.$eval('#subpl-table', t => t.parentElement.getBoundingClientRect().left);
  assert.ok(Math.abs(box.x - wrap) < 2, `SKU header still at the left edge after scrolling (${box.x} vs ${wrap})`);
  await p.setViewportSize({ width: 1360, height: 1000 });
  await p.click('#subpl-by-type');
  assert.deepEqual((await frozen()).map(x => x.t.replace(/\s*[▲▼]$/, '')), ['Type'], 'by type: only the Type column');
  assert.match(await p.locator('#subpl-head').innerText(), /^TYPE/i);
  assert.ok(await p.locator('#subpl-body tr').count() >= 1, 'rows or the empty message');
  assert.ok(await p.locator('#sub-kpis .gp-kpi').count() === 3, 'subscription KPI cards moved here');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('button[onclick="downloadSubPLCSV()"]')]);
  assert.match(dl.suggestedFilename(), /^subscription_pl_by_type_/);
  assert.deepEqual(p.errors, []);
});

test('Shipping table row → its orders in Order detail; vendor and subscription filters; CSV', { skip: !haveBrowser && 'Playwright not installed' }, async () => {
  const p = await openWeek();
  await p.evaluate(() => window.gotoScreen('shipping'));
  await p.waitForSelector('#ship-vendor-table tbody tr', { state: 'visible' });
  const vrow = p.locator('#ship-vendor-table tbody tr').first();
  const vOrders = amount(await vrow.locator('td').nth(1).innerText());
  const vNet = amount(await vrow.locator('td').last().innerText());
  await vrow.locator('button.gp-link').click();
  await p.waitForSelector('#view-shiporders', { state: 'visible' });
  assert.equal(await p.locator('#ship-focus-row').isHidden(), false, 'the row is shown as the filter');
  assert.equal(await p.locator('#seg-ship').getAttribute('aria-pressed'), 'true');
  const meta = await p.locator('#shiporders-meta').innerText();
  assert.match(meta, new RegExp(`^${vOrders.toLocaleString('en-US')} orders`), meta);
  const foot = p.locator('#shiporders-tfoot td');
  // The order list's net is the orders' whole shipping; for a measured vendor row it equals the row's net
  // unless an order also has a pass-through part (net $0 by rule), so the totals match.
  assert.equal(amount(await foot.last().innerText()), vNet);
  // Biggest loss first.
  const nets = await p.$$eval('#shiporders-body tr', trs => trs.map(tr => tr.cells[8]?.innerText));
  const vals = nets.map(amount);
  assert.deepEqual(vals, [...vals].sort((a, b) => a - b));
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('button[onclick="downloadShipOrdersCSV()"]')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  assert.match(csv, /Order,Date,Channel,Shipping vendor/);
  // Clearing the row filter shows every order; the shipping-vendor select narrows to the same orders.
  await p.click('#ship-focus-row button');
  assert.equal(await p.locator('#ship-focus-row').isHidden(), true);
  const key = await p.$eval('#filter-shipvendor', s => s.options[1].value);
  await p.selectOption('#filter-shipvendor', key);
  assert.match(await p.locator('#shiporders-meta').innerText(), new RegExp(`^${vOrders.toLocaleString('en-US')} orders`));
  // The SKU view follows the same filter (every line of those orders).
  await p.click('#seg-sku');
  const skuOrders = await p.evaluate(() => new Set([...document.querySelectorAll('#table-body tr td:first-child')].map(td => td.innerText)).size);
  assert.ok(skuOrders > 0 && skuOrders <= vOrders);
  // Subscription filter: the fixture has no subscriptions, so "Subscription orders" leaves none.
  await p.selectOption('#filter-shipvendor', '');
  await p.selectOption('#filter-sub', 'sub');
  await p.click('#seg-ship');
  assert.match(await p.locator('#shiporders-meta').innerText(), /^0 orders/);
  await p.selectOption('#filter-sub', 'nonsub');
  assert.ok(amount((await p.locator('#shiporders-meta').innerText()).split(' ')[0]) > 0);
  assert.deepEqual(p.errors, []);
});
