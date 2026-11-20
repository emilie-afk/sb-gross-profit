/**
 * Browser regression (2026-11-20): a cost table whose request FAILED is not kept for the tab. The next report open asks
 * for it again; a table that loaded (also an empty one) is not asked for again.
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

test('a failed cost-table request is retried on the next report open; loaded tables are not requested again', { skip: !haveBrowser && 'Playwright not installed' }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
  await ctx.addCookies([{ name: '__gp_session', value: h.gateCookie, domain: '127.0.0.1', path: '/' }]);
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', e => errors.push(String(e)));
  // Fail the first request of two tables in different ways, and the first extra-cost request; then let them through.
  const seen = { 'vendor_costs.json': 0, 'product_costs.json': 0, 'mcg_total.json': 0, 'mcg-extra': 0 };
  await p.route('**/data/vendor_costs.json', r => (++seen['vendor_costs.json'] === 1 ? r.fulfill({ status: 500, body: 'error' }) : r.continue()));
  await p.route('**/data/product_costs.json', r => (++seen['product_costs.json'] === 1 ? r.fulfill({ status: 200, contentType: 'text/html', body: '<html>Sign in</html>' }) : r.continue()));
  await p.route('**/data/mcg_total.json', r => { seen['mcg_total.json']++; return r.continue(); });
  await p.route('**/api/mcg-extra', r => (++seen['mcg-extra'] === 1 ? r.abort() : r.continue()));
  const loaded = () => p.waitForFunction(() => !document.getElementById('loading').classList.contains('active'));

  await p.goto(h.url + '/'); await p.click('text=View weekly reports'); await p.waitForSelector('.gp-auto-weeks');
  await p.click('.gp-auto-weeks button:has-text("2026-09-14")');
  await p.waitForSelector('#dashboard', { state: 'visible' }); await loaded();
  await p.waitForFunction(() => true);
  assert.deepEqual(seen, { 'vendor_costs.json': 1, 'product_costs.json': 1, 'mcg_total.json': 1, 'mcg-extra': 1 }, 'first open: one request each');

  // Another report: the failed requests are made again (and now succeed); the loaded table is not.
  await p.evaluate(() => window.stepStored(-1)); await loaded();
  await p.waitForFunction(() => document.getElementById('topbar-sub').textContent.includes('2026-09-07'));
  assert.deepEqual(seen, { 'vendor_costs.json': 2, 'product_costs.json': 2, 'mcg_total.json': 1, 'mcg-extra': 2 }, 'second open: only the failed ones again');

  // A third open: everything is loaded, nothing is requested again.
  await p.evaluate(() => window.stepStored(1)); await loaded();
  await p.waitForFunction(() => document.getElementById('topbar-sub').textContent.includes('2026-09-14'));
  await p.waitForTimeout(300);
  assert.deepEqual(seen, { 'vendor_costs.json': 2, 'product_costs.json': 2, 'mcg_total.json': 1, 'mcg-extra': 2 }, 'third open: no cost-table request');
  assert.deepEqual(errors, []);
});
