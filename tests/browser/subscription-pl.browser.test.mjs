/**
 * Browser regression: Subscription P&L opens on automatic (saved) reports, not only on CSV uploads.
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

test('a saved weekly report: the Subscription P&L tile is enabled and opens its table', { skip: !haveBrowser && 'Playwright not installed' }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
  await ctx.addCookies([{ name: '__gp_session', value: h.gateCookie, domain: '127.0.0.1', path: '/' }]);
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', e => errors.push(String(e)));
  await p.goto(h.url + '/'); await p.click('text=View weekly reports'); await p.waitForSelector('.gp-auto-weeks');
  await p.click('.gp-auto-weeks button:has-text("2026-09-14")');
  await p.waitForSelector('#dashboard', { state: 'visible' });
  await p.waitForFunction(() => !document.getElementById('loading').classList.contains('active'));
  await p.evaluate(() => window.gotoScreen('reports'));
  const btn = p.locator('[data-report="subpl"]');
  assert.equal(await btn.isDisabled(), false);
  assert.equal((await btn.innerText()).trim(), 'Open report');
  await btn.click();
  await p.waitForSelector('#view-subpl', { state: 'visible' });
  assert.ok(await p.locator('#subpl-body tr').count() >= 1, 'table rows or the empty-range message');
  assert.deepEqual(errors, []);
});
