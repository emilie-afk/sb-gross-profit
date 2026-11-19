/**
 * Browser regression: a welcome button clicked before the page script is ready.
 *   • the welcome screen is visible while the page script is still loading (one module held back here);
 *   • a click then shows "Loading…" on that button and a status line, with no page error (it used to throw
 *     "openSaved is not defined" and do nothing);
 *   • the choice opens by itself once the script is ready, and the button text comes back;
 *   • a second, different click before then replaces the first.
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

/** A page whose script is held back until release() (one imported module answers late). */
async function slowPage() {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
  await ctx.addCookies([{ name: '__gp_session', value: h.gateCookie, domain: '127.0.0.1', path: '/' }]);
  const p = await ctx.newPage();
  p.errors = []; p.on('pageerror', e => p.errors.push(String(e)));
  let release; const held = new Promise(r => { release = r; });
  await p.route('**/js/storedReport.js', async route => { await held; await route.continue(); });
  await p.goto(h.url + '/', { waitUntil: 'commit' });
  await p.waitForSelector('#welcome-screen button:has-text("View monthly reports")', { state: 'visible' });
  return { p, release };
}
const text = (p, sel) => p.evaluate(s => (document.querySelector(s)?.innerText || '').replace(/\s+/g, ' ').trim(), sel);

test('a welcome click before the page script is ready is kept and opens once it is', { skip: !haveBrowser && 'Playwright not installed' }, async () => {
  const { p, release } = await slowPage();
  assert.equal(await p.evaluate(() => typeof window.weeklyReports), 'undefined', 'the page script is still loading');
  await p.click('#welcome-screen button:has-text("View monthly reports")');
  assert.equal(await text(p, '#wl-loading'), 'Loading the dashboard…');
  assert.equal(await p.locator('#welcome-screen .wl-card:has(#wl-monthly) .wl-btn').innerText(), 'Loading…');
  assert.equal(await p.getAttribute('#welcome-screen .wl-btn.primary', 'aria-busy'), 'true');
  assert.deepEqual(p.errors, [], 'no "openSaved is not defined"');
  release();
  await p.waitForSelector('.gp-auto-months, #auto-reports .meta', { state: 'visible' });
  assert.equal(await p.getAttribute('#auto-reports .gp-seg button:has-text("Monthly")', 'aria-pressed'), 'true', 'the monthly list opened by itself');
  assert.equal(await p.locator('#welcome-screen .wl-card:has(#wl-monthly) .wl-btn').innerText(), 'View monthly reports', 'label restored');
  assert.equal(await p.locator('#wl-loading').isHidden(), true);
  assert.equal(await p.locator('#welcome-screen [aria-busy]').count(), 0);
  assert.deepEqual(p.errors, []);
});

test('the last welcome click before the page is ready wins', { skip: !haveBrowser && 'Playwright not installed' }, async () => {
  const { p, release } = await slowPage();
  await p.click('#welcome-screen button:has-text("View monthly reports")');
  await p.click('#welcome-screen button:has-text("View weekly reports")');
  assert.equal(await p.locator('#welcome-screen .wl-card:has(#wl-monthly) .wl-btn').innerText(), 'View monthly reports', 'the earlier button reads normally again');
  assert.equal(await p.locator('#welcome-screen .wl-btn.primary').innerText(), 'Loading…');
  release();
  await p.waitForSelector('.gp-auto-weeks', { state: 'visible' });
  assert.equal(await p.getAttribute('#auto-reports .gp-seg button:has-text("Weekly")', 'aria-pressed'), 'true');
  assert.deepEqual(p.errors, []);
});

test('once the page script is ready the welcome buttons work directly', { skip: !haveBrowser && 'Playwright not installed' }, async () => {
  const { p, release } = await slowPage();
  release();
  await p.waitForFunction(() => typeof window.weeklyReports === 'object');
  await p.click('#welcome-screen button:has-text("View monthly reports")');
  await p.waitForSelector('.gp-auto-months, #auto-reports .meta', { state: 'visible' });
  assert.equal(await p.locator('#wl-loading').isHidden(), true, 'no loading note when nothing was waiting');
  assert.deepEqual(p.errors, []);
});
