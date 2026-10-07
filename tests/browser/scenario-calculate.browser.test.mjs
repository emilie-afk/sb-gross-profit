/**
 * Browser regression: Discount & operating margin — changing the dates and pressing "Calculate scenario" updates
 * the displayed results (saved monthly report and CSV upload); typing does not recalculate on its own; no matching
 * orders clears the previous results with a message; no $9,500 labor reconciliation error.
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
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 1200 } });
  await ctx.addCookies([{ name: '__gp_session', value: h.gateCookie, domain: '127.0.0.1', path: '/' }]);
  const p = await ctx.newPage();
  p.errors = []; p.on('pageerror', e => p.errors.push(String(e)));
  return p;
}
const read = p => p.evaluate(() => ({
  kpis: document.getElementById('sc-kpis').innerText.replace(/\s+/g, ' ').trim(),
  alerts: document.getElementById('sc-alerts').innerText.replace(/\s+/g, ' ').trim(),
  status: document.getElementById('sc-status').innerText.trim(),
  compare: document.getElementById('sc-compare').innerText.replace(/\s+/g, ' ').trim(),
}));
async function openDiscount(p) {
  await p.click('#nav-scenarios'); await p.click('.gp-pick[data-model="discount"]');
  await p.waitForFunction(() => document.getElementById('sc-kpis')?.innerText.trim().length > 0);
}
/** Type a date as a person does (digit by digit), then press Calculate. */
async function typeDate(p, id, mmddyyyy) { await p.click(`#${id}`); await p.keyboard.type(mmddyyyy); }

async function checkCalculate(p, { from, to, narrowFrom }) {
  await openDiscount(p);
  const before = await read(p);
  assert.match(before.status, /Calculated/);
  assert.equal(await p.inputValue('#sc-from'), from);
  // Typing changes nothing until Calculate is pressed (no partial-date recalculation); the view says so.
  await typeDate(p, 'sc-from', narrowFrom.us);
  const typed = await read(p);
  assert.equal(typed.kpis, before.kpis, 'results unchanged while typing');
  assert.match(typed.status, /press Calculate scenario/);
  // Calculate: a visible updating state, then new results for the narrower dates.
  await p.click('#sc-calc');
  assert.equal(await p.textContent('#sc-calc'), 'Updating…');
  await p.waitForFunction(() => document.getElementById('sc-calc').textContent === 'Calculate scenario');
  const after = await read(p);
  assert.notEqual(after.kpis, before.kpis, 'results updated for the new dates');
  assert.match(after.status, new RegExp(`Calculated .*${narrowFrom.label}`));
  assert.doesNotMatch(after.alerts, /reconcil/i, 'no reconciliation warning');
  // No orders in the range: a message, and the previous results are cleared.
  await p.fill('#sc-from', '2026-12-01'); await p.fill('#sc-to', '2026-12-31');
  await p.click('#sc-calc'); await p.waitForFunction(() => document.getElementById('sc-calc').textContent === 'Calculate scenario');
  const none = await read(p);
  assert.match(none.alerts, /No orders match these filters from Dec 1, 2026 to Dec 31, 2026/);
  assert.equal(none.kpis, ''); assert.equal(none.compare, '');
  assert.doesNotMatch(none.alerts, /9,500/);
  // Reversed dates are refused with a message, not calculated.
  await p.fill('#sc-from', to); await p.fill('#sc-to', from);
  await p.click('#sc-calc'); await p.waitForFunction(() => document.getElementById('sc-calc').textContent === 'Calculate scenario');
  assert.match((await read(p)).alerts, /is after the end date/);
  assert.deepEqual(p.errors, []);
}

test('saved monthly report: changing dates and pressing Calculate updates the results', { skip: !haveBrowser && 'Playwright not installed' }, async () => {
  const p = await page();
  await p.goto(h.url + '/'); await p.click('text=View monthly reports'); await p.waitForSelector('.gp-auto-months');
  await p.click('.gp-auto-months button:has-text("September 2026")');
  await p.waitForSelector('#dashboard', { state: 'visible' });
  await p.waitForFunction(() => !document.getElementById('loading').classList.contains('active'));
  await checkCalculate(p, { from: '2026-09-01', to: '2026-09-27', narrowFrom: { us: '09152026', label: 'Sep 15, 2026' } });
});

test('CSV upload: changing dates and pressing Calculate updates the results', { skip: !haveBrowser && 'Playwright not installed' }, async () => {
  const p = await page();
  await p.goto(h.url + '/'); await p.click('text=Upload files');
  await p.setInputFiles('#input-orders', h.csvFile);
  await p.waitForTimeout(500); await p.click('#calc-btn');
  await p.waitForSelector('#dashboard', { state: 'visible', timeout: 60000 });
  await openDiscount(p);
  const f = await p.inputValue('#sc-from'), t = await p.inputValue('#sc-to');
  const mid = new Date(Date.parse(f) + (Date.parse(t) - Date.parse(f)) / 2).toISOString().slice(0, 10);
  const us = `${mid.slice(5, 7)}${mid.slice(8, 10)}${mid.slice(0, 4)}`;
  const label = new Date(`${mid}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  await checkCalculate(p, { from: f, to: t, narrowFrom: { us, label } });
});
