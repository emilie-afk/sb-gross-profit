/**
 * Browser regression: saved reports for custom dates.
 *   • Welcome → "Or choose your own dates" → the form (defaults to the last published week) → the report;
 *   • a range that is exactly a published week shows the same figures as that week;
 *   • a range crossing week boundaries opens with the split-week note; previous/next move by the same number of days;
 *   • days after the last published week are listed as not included, never blocked by the date inputs;
 *   • refusals are explained in words; "Choose dates…" inside a report opens the inline picker;
 *   • phone width: no horizontal scrolling with the picker open.
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

async function page(viewport = { width: 1360, height: 1100 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addCookies([{ name: '__gp_session', value: h.gateCookie, domain: '127.0.0.1', path: '/' }]);
  const p = await ctx.newPage();
  p.errors = []; p.on('pageerror', e => p.errors.push(String(e)));
  return p;
}
const text = (p, sel) => p.evaluate(s => (document.querySelector(s)?.innerText || '').replace(/\s+/g, ' ').trim(), sel);
const loaded = p => p.waitForFunction(() => !document.getElementById('loading').classList.contains('active'));
const figures = async p => ({ gp: await text(p, '#c-gp'), revenue: await text(p, '#c-revenue'), orders: await text(p, '#c-revenue-sub') });

async function openRange(p, from, to) {
  await p.fill('#wr-range-from', from); await p.fill('#wr-range-to', to);
  await p.click('.gp-range-form button[type=submit]');
}

test('custom dates from the welcome screen, a week-shaped range equals the week, split weeks, neighbours', { skip: !haveBrowser && 'Playwright not installed' }, async () => {
  const p = await page();
  // The week of Sep 14 from the weekly list: the reference figures.
  await p.goto(h.url + '/'); await p.click('text=View weekly reports'); await p.waitForSelector('.gp-auto-weeks');
  await p.click('.gp-auto-weeks button:has-text("2026-09-14")');
  await p.waitForSelector('#dashboard', { state: 'visible' }); await loaded(p);
  const week = await figures(p);
  assert.match(week.orders, /^\d+ orders$/);

  // Welcome → custom dates: the form opens on the last published week.
  await p.goto(h.url + '/'); await p.click('text=Or choose your own dates');
  await p.waitForSelector('#wr-range-from');
  assert.equal(await p.inputValue('#wr-range-from'), '2026-09-21');
  assert.equal(await p.inputValue('#wr-range-to'), '2026-09-27');
  assert.match(await text(p, '#auto-reports'), /Published reports cover .*–Sep 27, 2026/);

  // Exactly the week of Sep 14: same figures as the week report.
  await openRange(p, '2026-09-14', '2026-09-20');
  await p.waitForSelector('#dashboard', { state: 'visible' }); await loaded(p);
  assert.match(await text(p, '#topbar-sub'), /^Sep 14–20, 2026 \(Los Angeles time\) · \d+ orders/);
  assert.deepEqual(await figures(p), week, 'a range that is a whole week shows the week');
  assert.match(await text(p, '#c-gpm'), /margin \(from these days’ amounts\)/);
  assert.equal(await p.inputValue('#stored-period'), 'range:2026-09-14_2026-09-20');

  // Previous: the 7 days before (the week of Sep 7).
  await p.click('#stored-prev'); await loaded(p);
  await p.waitForFunction(() => /Sep 7–13, 2026/.test(document.getElementById('topbar-sub').innerText));

  // Inside the report: "Choose dates…" opens the inline picker prefilled with the open days; a range across two weeks.
  await p.selectOption('#stored-period', 'range:pick');
  assert.equal(await p.isVisible('#stored-range'), true);
  assert.equal(await p.inputValue('#stored-period'), 'range:2026-09-07_2026-09-13', 'the selector stays on the open report');
  assert.equal(await p.inputValue('#stored-range-from'), '2026-09-07');
  await p.fill('#stored-range-from', '2026-09-10'); await p.fill('#stored-range-to', '2026-09-16');
  await p.click('#stored-range button[type=submit]'); await loaded(p);
  await p.waitForFunction(() => /Sep 10–16, 2026/.test(document.getElementById('topbar-sub').innerText));
  assert.equal(await p.isVisible('#stored-range'), false, 'the picker closes once the report opens');
  assert.match(await text(p, '#c3-disclosure-body'), /Weeks crossing the date range boundary are split by order date/);

  // Reversed dates are refused in words; the open report stays.
  await p.selectOption('#stored-period', 'range:pick');
  await p.fill('#stored-range-from', '2026-09-16'); await p.fill('#stored-range-to', '2026-09-10');
  await p.click('#stored-range button[type=submit]');
  assert.match(await text(p, '#stored-switch-msg'), /The start date is after the end date/);
  assert.match(await text(p, '#topbar-sub'), /Sep 10–16, 2026/);
  assert.deepEqual(p.errors, []);
});

test('days after the last published week are listed, not blocked; refusals explained; phone width', { skip: !haveBrowser && 'Playwright not installed' }, async () => {
  const p = await page({ width: 390, height: 900 });
  await p.goto(h.url + '/'); await p.click('text=Or choose your own dates'); await p.waitForSelector('#wr-range-from');
  // Nothing published: explained, stays on the form.
  await openRange(p, '2026-10-01', '2026-10-07');
  await p.waitForSelector('#auto-reports [role=alert]');
  assert.match(await text(p, '#auto-reports [role=alert]'), /No published week covers these dates\. Published reports cover .*Sep 27, 2026/);
  // Partly published: opens Sep 24–27, lists Sep 28–30.
  await openRange(p, '2026-09-24', '2026-09-30');
  await p.waitForSelector('#dashboard', { state: 'visible' }); await loaded(p);
  const disc = await text(p, '#c3-disclosure-body');
  assert.match(disc, /Partial date range: published weeks cover 4 of 7 days \(Sep 24–Sep 27\)/);
  assert.match(disc, /Sep 28–Sep 30 not included: the week of Sep 28 has no published report/);
  await p.selectOption('#stored-period', 'range:pick');
  assert.equal(await p.isVisible('#stored-range'), true);
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `no horizontal scrolling at 390 px (overflow ${overflow})`);
  assert.deepEqual(p.errors, []);
});
