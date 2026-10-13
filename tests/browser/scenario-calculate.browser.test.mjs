/**
 * Browser regression: Discount & operating margin decision view.
 *   • the two modes (Maximum discount / Cost reduction for a bigger discount) and their action buttons;
 *   • editing an input keeps the previous answer visible, marked "Recalculate needed" (comparison table too);
 *   • a comparison row selects that discount and shows its cost-reduction answer;
 *   • custom comparison levels; costed-products-only labelling;
 *   • dates: typing does not recalculate; no matching orders clears results; reversed dates are refused;
 *   • desktop and mobile: no horizontal scrolling for the main answer and the comparison table.
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

async function page(viewport = { width: 1360, height: 1200 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addCookies([{ name: '__gp_session', value: h.gateCookie, domain: '127.0.0.1', path: '/' }]);
  const p = await ctx.newPage();
  p.errors = []; p.on('pageerror', e => p.errors.push(String(e)));
  return p;
}
const text = (p, id) => p.evaluate(i => (document.getElementById(i)?.innerText || '').replace(/\s+/g, ' ').trim(), id);
const read = async p => ({
  answer: await text(p, 'sc-answer'), sub: await text(p, 'sc-answer-sub'), support: await text(p, 'sc-support'),
  levels: await text(p, 'sc-levels'), status: await text(p, 'sc-status'), alerts: await text(p, 'sc-alerts'),
  coverage: await text(p, 'sc-coverage-status'), basis: await text(p, 'sc-basis'),
  answerStale: await p.evaluate(() => document.getElementById('sc-answer-card').classList.contains('is-stale')),
  levelsStale: await p.evaluate(() => document.getElementById('sc-levels-card').classList.contains('is-stale')),
});
const done = (p, id) => p.waitForFunction(i => !document.getElementById(i).disabled && !/Updating/.test(document.getElementById(i).textContent), id);
async function press(p, id) { await p.click(`#${id}`); await done(p, id); }

async function openMonthly(p) {
  await p.goto(h.url + '/'); await p.click('text=View monthly reports'); await p.waitForSelector('.gp-auto-months');
  await p.click('.gp-auto-months button:has-text("September 2026")');
  await p.waitForSelector('#dashboard', { state: 'visible' });
  await p.waitForFunction(() => !document.getElementById('loading').classList.contains('active'));
}
async function openDiscount(p) {
  await p.click('#nav-scenarios'); await p.click('.gp-pick[data-model="discount"]');
  await p.waitForFunction(() => document.getElementById('sc-answer')?.innerText.trim().length > 0);
}
/** Assumptions that give the synthetic fixture a reachable target. */
async function setAssumptions(p, { ad = '0', labor = '0', target = '1' } = {}) {
  await p.click('#sc-assump summary');
  await p.fill('#sc-ad', ad); await p.fill('#sc-labor', labor);
  await p.click('#sc-assump summary');
  await p.fill('#sc-target', target);
}

test('modes, stale results, comparison rows and costed-only labels (saved monthly report)', { skip: !haveBrowser && 'Playwright not installed' }, async () => {
  const p = await page();
  await openMonthly(p);
  await openDiscount(p);

  // Opens in Maximum discount mode, already calculated for the report, with coverage status above the answer.
  assert.equal(await p.getAttribute('#sc-mode-max', 'aria-checked'), 'true');
  assert.equal(await p.isVisible('#sc-calc-max'), true);
  assert.equal(await p.isVisible('#sc-calc-cost'), false);
  assert.equal(await p.isVisible('#sc-sitewide'), false, 'no proposed discount input in maximum-discount mode');
  let r = await read(p);
  assert.match(r.status, /Calculated/);
  assert.match(r.coverage, /Provisional: missing product costs/);
  assert.match(r.basis, /Provisional: missing product costs/);
  assert.match(await text(p, 'sc-assump-sum'), /Advertising 15% of product revenue · Labor \$9,500\.00\/month/);
  assert.equal(await p.isVisible('#sc-ad'), false, 'assumptions panel collapsed, summary visible');
  assert.match(await text(p, 'sc-answer-card'), /Does not predict additional sales from a discount/);
  assert.doesNotMatch(await text(p, 'view-scenario'), /Target achievable/);
  // The default labor makes this synthetic month unprofitable: an explicit statement, never 0% or negative.
  assert.match(r.answer, /target can’t be met, even with no general discount/);
  assert.doesNotMatch(r.answer, /up to -|up to −|up to 0%/);

  // Edit an input: the previous answer stays visible, marked "Recalculate needed", the comparison too.
  const before = r.answer;
  await setAssumptions(p);
  r = await read(p);
  assert.equal(r.answer, before, 'previous answer still visible');
  assert.equal(r.answerStale, true); assert.equal(r.levelsStale, true);
  assert.equal(await p.isVisible('#sc-answer-card .sc-badge.stale'), true);
  assert.equal(await p.isVisible('#sc-levels-card .sc-badge.stale'), true);
  assert.match(r.status, /Recalculate needed/);

  await p.click('#sc-calc-max');
  assert.equal(await p.textContent('#sc-calc-max'), 'Updating…');
  await done(p, 'sc-calc-max');
  r = await read(p);
  assert.equal(r.answerStale, false); assert.equal(r.levelsStale, false);
  const m = r.answer.match(/^You can offer up to (\d+(?:\.5)?)% discount\.$/);
  assert.ok(m, `maximum-discount answer: ${r.answer}`);
  const maxD = Number(m[1]);
  assert.match(r.sub, new RegExp(`At ${maxD + 0.5}% the margin falls to`));
  assert.match(r.support, /Operating profit/i); assert.match(r.support, /Allocated labor/i);
  const maxAnswer = r.answer;

  // Switch mode: the other mode has no result yet; its own button and the proposed discount appear.
  await p.click('#sc-mode-cost');
  assert.equal(await p.getAttribute('#sc-mode-cost', 'aria-checked'), 'true');
  assert.equal(await p.isVisible('#sc-calc-cost'), true); assert.equal(await p.isVisible('#sc-calc-max'), false);
  assert.equal(await p.isVisible('#sc-sitewide'), true);
  assert.match((await read(p)).sub, /Press Calculate required cost reduction/);
  // Switching back shows the earlier maximum-discount answer, still current.
  await p.click('#sc-mode-max');
  r = await read(p);
  assert.equal(r.answer, maxAnswer); assert.equal(r.answerStale, false);

  // The comparison table: the four default levels, the proposed 10% and the solved maximum, which is highlighted.
  const maxLevel = String(Math.round(maxD * 10) / 1000);
  let rows = await p.$$eval('#sc-levels tbody tr', trs => trs.map(t => ({ d: t.dataset.d, sel: t.classList.contains('sel'), text: t.innerText.replace(/\s+/g, ' ') })));
  assert.deepEqual(rows.map(x => x.d), [...new Set([maxLevel, '0.05', '0.1', '0.15', '0.2'])].sort((x, y) => x - y));
  assert.deepEqual(rows.filter(x => x.sel).map(x => x.d), [maxLevel]);
  assert.match(rows.find(x => x.sel).text, /maximum/);
  assert.equal(await p.textContent('#sc-details-at'), `(at ${maxD}% general discount)`);
  // In cost mode the proposed discount is the selected level.
  await p.click('#sc-mode-cost');
  assert.equal(await p.getAttribute('#sc-levels tbody tr.sel', 'data-d'), '0.1');
  assert.equal(await p.isVisible('#sc-details-card'), false, 'no details until this mode is calculated');
  await p.click('#sc-mode-max');
  // Clicking a row selects that discount and switches to its cost-reduction result.
  const row15 = rows.find(x => x.d === '0.15').text;
  await p.click('#sc-levels tbody tr[data-d="0.15"]');
  await done(p, 'sc-calc-cost');
  assert.equal(await p.getAttribute('#sc-mode-cost', 'aria-checked'), 'true');
  assert.equal(await p.inputValue('#sc-sitewide'), '15');
  r = await read(p);
  assert.equal(await p.getAttribute('#sc-levels tbody tr.sel', 'data-d'), '0.15');
  const need = row15.match(/(\$[\d,]+\.\d\d) \((\d+\.\d)%\)/);
  assert.ok(need, `the 15% row needs a cost reduction: ${row15}`);
  assert.equal(r.answer, `Product costs must fall by ${need[2]}% (${need[1]}).`);
  assert.equal(await p.textContent('#sc-details-at'), '(at 15% general discount)');
  // Editing the proposed discount marks the cost answer stale but not the maximum-discount answer.
  await p.fill('#sc-sitewide', '20');
  assert.equal((await read(p)).answerStale, true);
  assert.equal(await p.getAttribute('#sc-levels tbody tr.sel', 'data-d'), '0.2', 'highlight follows the input');
  await p.click('#sc-mode-max');
  r = await read(p);
  assert.equal(r.answer, maxAnswer); assert.equal(r.answerStale, false); assert.equal(r.levelsStale, false);
  assert.equal(await p.textContent('#sc-details-at'), `(at ${maxD}% general discount)`, 'details follow the mode shown');
  await p.click('#sc-mode-cost'); await press(p, 'sc-calc-cost');
  r = await read(p);
  assert.match(r.support, /Current product COGS/i); assert.match(r.support, /Maximum affordable COGS/i);
  assert.match(r.support, /Operating margin without cost reduction/i);

  // A custom level is added with the same assumptions, without recalculating the answer.
  await p.fill('#sc-level-input', '12.5'); await p.click('#sc-level-add');
  assert.deepEqual(await p.$$eval('#sc-levels tbody tr', trs => trs.map(t => t.dataset.d)), ['0.05', '0.1', '0.125', '0.15', '0.2']);
  assert.equal((await read(p)).levelsStale, false);

  // Impossible target in cost mode.
  await p.fill('#sc-target', '95'); await press(p, 'sc-calc-cost');
  assert.equal((await read(p)).answer, 'Product-cost reduction alone cannot achieve this target.');
  assert.match(await text(p, 'sc-levels'), /Cannot achieve through product costs alone/);
  // Low target: none needed.
  await p.fill('#sc-target', '-50'); await press(p, 'sc-calc-cost');
  assert.equal((await read(p)).answer, 'No cost reduction needed.');
  assert.match(await text(p, 'sc-levels'), /None needed/);

  // Costed products only: labelled, with the excluded SKU, unit and revenue coverage.
  await p.fill('#sc-target', '1');
  await p.selectOption('#sc-missing', 'exclude'); await press(p, 'sc-calc-cost');
  r = await read(p);
  assert.match(r.basis, /Costed products only/);
  assert.match(r.coverage, /Costed products only\. Excluded: 1 of 8 SKUs, 96 of 953 units and \$967\.53 of \$9,860\.58 product revenue/);
  assert.match(await text(p, 'sc-levels-basis'), /Costed products only/);

  // Vendor filters carry their revenue share of the period's labor, shown as "Allocated labor", fixed across
  // discounts; all vendors together reconcile to the period's labor (Sep 1–27: $9,500 × 27 ÷ 30.4375).
  await p.click('#sc-assump summary'); await p.fill('#sc-labor', '9500'); await p.click('#sc-assump summary');
  await p.selectOption('#sc-missing', 'include');
  const periodLabor = Math.round(9500 * 27 / 30.4375 * 100) / 100;
  const vendors = await p.$eval('#sc-vendor-filter', s => [...s.options].map(o => o.value).filter(Boolean));
  const LABOR = /Allocated labor: \$([\d,]+\.\d\d), representing (\d+\.\d)% of the period’s labor\./;
  const laborOf = async () => { const m = (await text(p, 'sc-scope')).match(LABOR); assert.ok(m, await text(p, 'sc-scope')); return { dollars: Number(m[1].replace(/,/g, '')), pct: Number(m[2]) }; };
  let sum = 0;
  for (const v of vendors) {
    await p.selectOption('#sc-vendor-filter', v); await press(p, 'sc-calc-cost');
    if (!(await p.isVisible('#sc-answer-card'))) {                // e.g. a vendor with only Route lines: no products
      assert.match((await read(p)).alerts, /No orders match/); continue;
    }
    const l = await laborOf();
    assert.ok(Math.abs(l.dollars / periodLabor * 100 - l.pct) <= 0.051, `${v}: $${l.dollars} is ${l.pct}% of $${periodLabor}`);
    assert.match(await text(p, 'sc-scope'), /Filtered results use allocated labor/);
    assert.match(await text(p, 'sc-scope'), /do not predict payroll savings from removing a vendor/);
    assert.match((await read(p)).basis, /Allocated labor/);
    assert.match((await read(p)).support, /Allocated labor/i);
    sum += l.dollars;
  }
  assert.ok(Math.abs(sum - periodLabor) <= 0.01 * vendors.length, `vendors sum to $${sum}, period $${periodLabor}`);
  // A different proposed discount does not change the selection's labor.
  await p.selectOption('#sc-vendor-filter', vendors[0]); await press(p, 'sc-calc-cost');
  const atTen = await laborOf();
  await p.fill('#sc-sitewide', '30'); await press(p, 'sc-calc-cost');
  assert.deepEqual(await laborOf(), atTen);
  await p.click('#sc-mode-max'); await press(p, 'sc-calc-max');
  assert.deepEqual(await laborOf(), atTen, 'maximum-discount mode uses the same allocation');
  await p.click('#sc-mode-cost');
  // All vendors: 100% of the period's labor, no "allocated" label.
  await p.selectOption('#sc-vendor-filter', ''); await press(p, 'sc-calc-cost');
  assert.deepEqual(await laborOf(), { dollars: periodLabor, pct: 100 });
  assert.doesNotMatch((await read(p)).basis, /Allocated labor/);
  // Costed products only: the excluded products' share is removed, not loaded onto the rest.
  await p.selectOption('#sc-missing', 'exclude'); await press(p, 'sc-calc-cost');
  const costed = await laborOf();
  assert.ok(costed.dollars < periodLabor, 'excluded products keep their share out');
  assert.equal(costed.pct, Math.round(8893.05 / 9860.58 * 1000) / 10, 'share = costed historical net product revenue ÷ the period’s');
  await p.selectOption('#sc-vendor-filter', vendors[0]); await press(p, 'sc-calc-cost');
  assert.match(await text(p, 'sc-scope'), new RegExp(vendors[0]));
  await p.click('#sc-details summary');
  assert.match(await text(p, 'sc-compare'), /Allocated labor/);
  assert.match(await text(p, 'sc-method'), /historical net product revenue, \$[\d,.]+, over the\s+period's \$[\d,.]+/);
  assert.match(await text(p, 'sc-method'), /not verified vendor-specific shipping costs/);
  await p.click('#sc-details summary');

  // The single-product calculator is collapsed under "Check an individual product".
  assert.equal(await p.isVisible('#sp-price'), false);
  assert.match(await text(p, 'sc-single'), /^Check an individual product/);
  await p.click('#sc-single summary');
  assert.equal(await p.isVisible('#sp-price'), true);

  // Details hold the actual-vs-scenario table, vendor and SKU analysis.
  await p.click('#sc-details summary');
  assert.match(await text(p, 'sc-compare'), /Operating profit/);
  assert.ok((await text(p, 'sc-sku')).length > 0);
  assert.deepEqual(p.errors, []);
});

test('dates: typing does not recalculate; no matching orders and reversed dates (CSV upload)', { skip: !haveBrowser && 'Playwright not installed' }, async () => {
  const p = await page();
  await p.goto(h.url + '/'); await p.click('text=Upload files');
  await p.setInputFiles('#input-orders', h.csvFile);
  await p.waitForTimeout(500); await p.click('#calc-btn');
  await p.waitForSelector('#dashboard', { state: 'visible', timeout: 60000 });
  await openDiscount(p);
  await setAssumptions(p);
  await press(p, 'sc-calc-max');
  const before = await read(p);
  const f = await p.inputValue('#sc-from'), t = await p.inputValue('#sc-to');
  const mid = new Date(Date.parse(f) + (Date.parse(t) - Date.parse(f)) / 2).toISOString().slice(0, 10);
  await p.click('#sc-from'); await p.keyboard.type(`${mid.slice(5, 7)}${mid.slice(8, 10)}${mid.slice(0, 4)}`);
  const typed = await read(p);
  assert.equal(typed.answer, before.answer, 'results unchanged while typing');
  assert.equal(typed.answerStale, true);
  await press(p, 'sc-calc-max');
  const after = await read(p);
  const label = new Date(`${mid}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  assert.match(after.status, new RegExp(`Calculated .*${label}`));
  assert.notEqual(after.support, before.support, 'results updated for the new dates');
  assert.equal(after.answerStale, false);
  // No orders in range: a message, and previous results are cleared.
  await p.fill('#sc-from', '2026-12-01'); await p.fill('#sc-to', '2026-12-31'); await press(p, 'sc-calc-max');
  const none = await read(p);
  assert.match(none.alerts, /No orders match these filters from Dec 1, 2026 to Dec 31, 2026/);
  assert.equal(await p.isVisible('#sc-answer-card'), false);
  assert.equal(await p.isVisible('#sc-levels-card'), false);
  // Reversed dates are refused with a message, not calculated.
  await p.fill('#sc-from', t); await p.fill('#sc-to', f); await press(p, 'sc-calc-max');
  assert.match((await read(p)).alerts, /is after the end date/);
  assert.deepEqual(p.errors, []);
});

for (const vp of [{ name: 'desktop', width: 1360, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`${vp.name} layout: main answer and comparison table fit without horizontal scrolling`, { skip: !haveBrowser && 'Playwright not installed' }, async () => {
    const p = await page({ width: vp.width, height: vp.height });
    await openMonthly(p);
    await openDiscount(p);
    await setAssumptions(p);
    for (const [m, btn] of [['max', 'sc-calc-max'], ['cost', 'sc-calc-cost']]) {
      await p.click(`#sc-mode-${m}`); await press(p, btn);
      const fit = await p.evaluate(() => {
        const over = id => { const el = document.getElementById(id); return el.scrollWidth - el.clientWidth; };
        const t = document.getElementById('sc-levels'), card = document.getElementById('sc-levels-card');
        const main = document.querySelector('.gp-main');
        // Any descendant of the answer or comparison card reaching past the card's right edge.
        const spill = ['sc-answer-card', 'sc-levels-card'].map(id => {
          const card = document.getElementById(id), right = card.getBoundingClientRect().right;
          return Math.max(0, ...[...card.querySelectorAll('*')].filter(e => e.getClientRects().length)
            .map(e => e.getBoundingClientRect().right - right));
        });
        return { doc: document.documentElement.scrollWidth - window.innerWidth, main: main.scrollWidth - main.clientWidth,
                 spill: Math.max(...spill), answer: over('sc-answer-card'),
                 levels: over('sc-levels-card'), table: t.getBoundingClientRect().right - card.getBoundingClientRect().right,
                 answerRight: document.getElementById('sc-answer').getBoundingClientRect().right - window.innerWidth };
      });
      assert.ok(fit.doc <= 0, `${vp.name} ${m}: page scrolls sideways by ${fit.doc}px`);
      assert.ok(fit.main <= 0, `${vp.name} ${m}: the report area scrolls sideways by ${fit.main}px`);
      assert.ok(fit.spill <= 0.5, `${vp.name} ${m}: content spills ${fit.spill}px past its card`);
      assert.ok(fit.answer <= 0, `${vp.name} ${m}: answer card overflows by ${fit.answer}px`);
      assert.ok(fit.levels <= 0 && fit.table <= 0, `${vp.name} ${m}: comparison table overflows (${fit.levels}, ${fit.table})`);
      assert.ok(fit.answerRight <= 0, `${vp.name} ${m}: answer text beyond the viewport`);
    }
    assert.deepEqual(p.errors, []);
  });
}
