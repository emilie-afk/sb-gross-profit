/**
 * Browser regression: custom dates with "Include provisional data".
 *   • off by default: the unpublished week's days are listed as missing, never counted;
 *   • on: the unpublished week's latest verified revision fills those days; the report says Provisional and lists
 *     the provisional days, their shipping-cost coverage, missing costs and why the week is held;
 *   • totals add up from the included orders (published part + provisional part = the whole range);
 *   • the export starts with the status, included / provisional / missing dates and the warnings;
 *   • viewing and exporting publish nothing; the week stays unreadable without the toggle;
 *   • phone width: the picker with the toggle fits.
 *   npm run test:browser
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { start, PLAYWRIGHT } from './harness.mjs';

const HELD = '2026-09-21';
const haveBrowser = fs.existsSync(PLAYWRIGHT);
let h, chromium, browser;
test.before(async () => { if (!haveBrowser) return; ({ chromium } = await import(PLAYWRIGHT)); h = await start({ unpublished: [HELD] }); browser = await chromium.launch(); });
test.after(async () => { await browser?.close(); await h?.close(); });

async function page(viewport = { width: 1360, height: 1100 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  await ctx.addCookies([{ name: '__gp_session', value: h.gateCookie, domain: '127.0.0.1', path: '/' }]);
  const p = await ctx.newPage();
  p.errors = []; p.on('pageerror', e => p.errors.push(String(e)));
  return p;
}
const text = (p, sel) => p.evaluate(s => (document.querySelector(s)?.innerText || '').replace(/\s+/g, ' ').trim(), sel);
const loaded = p => p.waitForFunction(() => !document.getElementById('loading').classList.contains('active'));
const cents = t => { const v = String(t).trim(); return Math.round(Number(v.replace(/[^0-9.]/g, '')) * 100) * (/^[-−]/.test(v) ? -1 : 1); };
const statuses = () => h.env.DB.db.prepare('SELECT snapshot_id, status, published_at FROM snapshot ORDER BY snapshot_id').all();

async function openCustom(p, from, to, provisional) {
  await p.goto(h.url + '/'); await p.click('text=Or choose your own dates'); await p.waitForSelector('#wr-range-from');
  await p.fill('#wr-range-from', from); await p.fill('#wr-range-to', to);
  if (provisional) await p.check('#wr-range-prov');
  await p.click('.gp-range-form button[type=submit]');
  await p.waitForSelector('#dashboard', { state: 'visible' }); await loaded(p);
  return { orders: Number((await text(p, '#c-revenue-sub')).replace(/\D/g, '')), revenue: cents(await text(p, '#c-revenue')), gp: cents(await text(p, '#c-gp')) };
}

test('off by default; on: provisional days filled from the verified revision, marked, explained, exported; nothing published', { skip: !haveBrowser && 'Playwright not installed' }, async () => {
  const before = statuses();
  assert.ok(before.some(r => r.status === 'published'));
  const p = await page();

  // Default: published data only.
  await p.goto(h.url + '/'); await p.click('text=Or choose your own dates'); await p.waitForSelector('#wr-range-prov');
  assert.equal(await p.isChecked('#wr-range-prov'), false, 'off by default');
  const pub = await openCustom(p, '2026-09-17', '2026-09-23', false);
  assert.match(await text(p, '#stored-badge'), /Automatic report · Partial date range/);
  assert.match(await text(p, '#c3-disclosure-body'), /Sep 21–Sep 23 not included: the week of Sep 21 has no published report/);
  assert.match(await text(p, '#c3-disclosure-body'), /Computed weekly from the collected sources, independently verified and published; nothing was uploaded here\./);
  assert.match(await text(p, 'body'), /Some days have no published weekly report; the figures cover the published days only\./);

  // Only the unpublished days, provisional.
  const part = await openCustom(p, '2026-09-21', '2026-09-23', true);
  assert.ok(part.orders > 0);

  // The whole range with provisional data.
  const all = await openCustom(p, '2026-09-17', '2026-09-23', true);
  assert.match(await text(p, '#stored-badge'), /Automatic report · Provisional: includes unpublished data/);
  assert.match(await text(p, '#c-gp-label'), /Provisional operating GP after shipping/i);
  assert.equal(all.orders, pub.orders + part.orders, 'orders add up by their own date');
  assert.equal(all.revenue, pub.revenue + part.revenue, 'revenue recomputed from the included orders');
  assert.equal(all.gp, pub.gp + part.gp, 'GP recomputed from the included orders');
  const disc = await text(p, '#c3-disclosure-body');
  assert.match(disc, /Includes unpublished data: Sep 21–Sep 23 comes from a week not yet published/);
  assert.match(disc, /Sep 21–Sep 23 \(week of Sep 21, revision \d+, verified, not published\) · shipping cost on \d+ of \d+ orders \([\d.]+%\)/);
  assert.match(disc, /held by: /);
  assert.match(disc, /^Provisional operating GP after shipping\. Computed from collected sources and independently verified\. Published and unpublished dates are identified below\./);
  assert.doesNotMatch(disc, /verified and published/, 'never implies everything was published');
  assert.match(await text(p, '#c3-disclosure'), /published revision of each week, else its latest verified revision/);
  assert.doesNotMatch(disc, /Sep 21–Sep 23 not included/, 'never both missing and included');
  assert.match(await text(p, '.gp-alerts, #needs-attention, body'), /Unpublished data included/i);
  assert.match(await p.$eval('#stored-period', s => s.options[s.selectedIndex].text), /Sep 17–23, 2026 · with provisional data/);

  // Export: status, dates and warnings first.
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('.gp-header-actions button:has-text("Export CSV")')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  const head = csv.split('\r\n\r\n')[0];
  assert.match(head, /^Report,"Sep 17–23, 2026 \(Los Angeles dates\)"\r\nStatus,Provisional: includes unpublished data\r\n/);
  assert.match(head, /Included dates,Sep 17–Sep 20; Sep 21–Sep 23/);
  assert.match(head, /Provisional dates \(unpublished\),Sep 21–Sep 23/);
  assert.match(head, /Missing dates \(no usable data; not counted\),none/);
  assert.match(head, /held by: /);
  assert.ok(csv.split('\r\n\r\n')[1].length > 0, 'the table follows');

  // Provisional data on, some days still missing: the partial alert names published and provisional dates.
  await openCustom(p, '2026-09-21', '2026-09-30', true);
  const body = await text(p, 'body');
  assert.match(body, /Some days have no usable report\. Figures include only the published and verified provisional dates listed below\./);
  assert.doesNotMatch(body, /the figures cover the published days only/);
  const disc2 = await text(p, '#c3-disclosure-body');
  assert.match(disc2, /Usable reports cover 7 of 10 days, including published and verified provisional data\. Dates without usable data are listed below and excluded from totals\./);
  assert.match(disc2, /Sep 28–Sep 30 not included: the week of Sep 28 has no published or verified report/);
  assert.doesNotMatch(disc2, /published weeks cover|has no published report/, 'no message implies only published data');
  const [dl2] = await Promise.all([p.waitForEvent('download'), p.click('.gp-header-actions button:has-text("Export CSV")')]);
  const head2 = fs.readFileSync(await dl2.path(), 'utf8').split('\r\n\r\n')[0];
  assert.match(head2, /Missing dates \(no usable data; not counted\),Sep 28–Sep 30 \((no published or verified report|[a-z ]+)\)/);
  assert.match(head2, /Note,"Usable reports cover 7 of 10 days, including published and verified provisional data\. Dates without usable data are listed below and excluded from totals\."/);
  assert.doesNotMatch(head2, /published weeks cover|has no published report/);
  await openCustom(p, '2026-09-17', '2026-09-23', true);

  // The inline picker keeps the toggle; turning it off drops the unpublished days again.
  await p.selectOption('#stored-period', 'range:pick');
  assert.equal(await p.isChecked('#stored-range-prov'), true);
  await p.uncheck('#stored-range-prov'); await p.click('#stored-range button[type=submit]'); await loaded(p);
  await p.waitForFunction(() => /Partial date range/.test(document.getElementById('stored-badge').innerText));
  assert.equal(Number((await text(p, '#c-revenue-sub')).replace(/\D/g, '')), pub.orders);

  // Nothing was published by viewing or exporting; the week is still unreadable without the toggle.
  assert.deepEqual(statuses(), before);
  const r = await p.evaluate(async w => (await fetch(`/api/v1/snapshot/${w}`)).status, HELD);
  assert.equal(r, 404);
  assert.deepEqual(p.errors, []);
});

test('phone width: the picker with the toggle fits without sideways scrolling', { skip: !haveBrowser && 'Playwright not installed' }, async () => {
  const p = await page({ width: 390, height: 900 });
  await openCustom(p, '2026-09-17', '2026-09-23', true);
  await p.selectOption('#stored-period', 'range:pick');
  assert.equal(await p.isVisible('#stored-range-prov'), true);
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `overflow ${overflow}`);
  assert.deepEqual(p.errors, []);
});
