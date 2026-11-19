/**
 * Browser regression: the Shipping screen's "Where the shipping net comes from" and "Shipping by vendor" tables.
 *   • a saved weekly report and a monthly report show both tables; each total equals the screen's net shipping;
 *   • every cause row and vendor row has an order count and amounts; pass-through rows read as not measured;
 *   • both CSV exports download the table with its total row.
 *   npm run test:browser
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { start, PLAYWRIGHT } from './harness.mjs';

const haveBrowser = fs.existsSync(PLAYWRIGHT);
let h, chromium, browser;
test.before(async () => { if (!haveBrowser) return; ({ chromium } = await import(PLAYWRIGHT)); h = await start(); browser = await chromium.launch(); });
test.after(async () => { await browser?.close(); await h?.close(); });

async function page() {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 1100 }, acceptDownloads: true });
  await ctx.addCookies([{ name: '__gp_session', value: h.gateCookie, domain: '127.0.0.1', path: '/' }]);
  const p = await ctx.newPage();
  p.errors = []; p.on('pageerror', e => p.errors.push(String(e)));
  return p;
}
const loaded = p => p.waitForFunction(() => !document.getElementById('loading').classList.contains('active'));
const amount = t => Number(String(t).replace(/[$,\s]/g, '').replace(/^−/, '-'));
const cell = (p, sel) => p.evaluate(s => document.querySelector(s)?.innerText.trim() || '', sel);

async function checkShipping(p) {
  await p.evaluate(() => window.gotoScreen('shipping'));
  await p.waitForSelector('#ship-cause-table tbody tr', { state: 'visible' });
  const net = amount(await cell(p, '#ship-profile-table tfoot td:last-child'));
  const orders = amount(await cell(p, '#ship-profile-table tfoot td:nth-child(2)'));
  for (const t of ['#ship-cause-table', '#ship-vendor-table']) {
    assert.equal(amount(await cell(p, `${t} tfoot td:last-child`)), net, `${t} total = net shipping`);
    assert.equal(amount(await cell(p, `${t} tfoot td:nth-child(2)`)), orders, `${t} counts every order`);
    const rows = await p.$$eval(`${t} tbody tr`, trs => trs.map(tr => [...tr.cells].map(c => c.innerText.trim())));
    assert.ok(rows.length >= 2, `${t} has rows`);
    const sum = rows.reduce((s, r) => s + amount(r[r.length - 1]), 0);
    assert.ok(Math.abs(sum - net) < 0.005, `${t} rows add up (${sum} vs ${net})`);
  }
  const vendors = await p.$$eval('#ship-vendor-table tbody tr', trs => trs.map(tr => tr.cells[0].innerText.trim()));
  for (const v of vendors.filter(v => /pass-through/.test(v))) assert.match(v, /not measured/);
}

test('weekly and monthly saved reports: both breakdown tables add up to the net shipping, CSV exports', { skip: !haveBrowser && 'Playwright not installed' }, async () => {
  const p = await page();
  await p.goto(h.url + '/'); await p.click('text=View weekly reports'); await p.waitForSelector('.gp-auto-weeks');
  await p.click('.gp-auto-weeks button:has-text("2026-09-14")');
  await p.waitForSelector('#dashboard', { state: 'visible' }); await loaded(p);
  await checkShipping(p);
  for (const [kind, file] of [['causes', 'shipping_net_by_cause.csv'], ['vendors', 'shipping_by_vendor.csv']]) {
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click(`button[onclick="downloadShipBreakdown('${kind}')"]`)]);
    assert.equal(dl.suggestedFilename(), file);
    const text = fs.readFileSync(await dl.path(), 'utf8').trim().split('\n');
    assert.match(text[0], kind === 'vendors' ? /^Vendor,Orders,Collected,Paid,Net/ : /^Where the shipping net comes from,Orders/);
    assert.match(text[text.length - 1], /^Total,/);
  }
  await p.goto(h.url + '/'); await p.click('text=View monthly reports'); await p.waitForSelector('.gp-auto-months');
  await p.click('.gp-auto-months button >> nth=0');
  await p.waitForSelector('#dashboard', { state: 'visible' }); await loaded(p);
  await checkShipping(p);
  assert.deepEqual(p.errors, []);
});
