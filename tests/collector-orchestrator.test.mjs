/**
 * C7 — the Windows collector orchestrator: one browser at a time, ShipStation
 * first, its upload during the Shopify email wait, independent sources,
 * missed-run catch-up and a single instance. Fakes only; no Playwright.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWeeklyCollection, acquireLock, releaseLock, LOCK_STALE_MS, EXIT } from '../automation/collector/src/orchestrate.mjs';

const week = { weekStart: '2026-09-14', weekEnd: '2026-09-20', closed: true };
function rig({ collected = { shopify: 'missing', shopify_updates: 'missing', shipping_cost_report: 'missing' }, planDown = false,
               ssStatus = 'prepared', ssUpload = 'ok', shopify = 'ok', emailed = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-orch-'));
  const log = [];
  let browsers = 0, maxBrowsers = 0;
  const open = name => { browsers++; maxBrowsers = Math.max(maxBrowsers, browsers); log.push(`${name}:open`); };
  const close = name => { browsers--; log.push(`${name}:close`); };
  const d = {
    week, lockFile: path.join(dir, 'collector.lock'), stateFile: path.join(dir, 'state.json'),
    weekPlan: async () => { if (planDown) throw new Error('unreachable'); return { weekStart: week.weekStart, collected }; },
    shipstation: {
      collect: async () => { open('shipstation'); await new Promise(r => setTimeout(r, 2)); close('shipstation');
        return ssStatus === 'prepared' ? { status: 'prepared', pending: { sanitized: true } } : { status: ssStatus, exitCode: 20 }; },
      upload: async p => { log.push(`shipstation:upload(${browsers} browser open)`); assert.equal(p.sanitized, true); return { status: ssUpload, exitCode: ssUpload === 'ok' ? 0 : 31 }; },
    },
    shopify: {
      run: async ({ onWaiting }) => {
        open('shopify'); log.push('shopify:requested');
        if (emailed) { const w = await onWaiting(); log.push(`shopify:waiting→${w}`); log.push('shopify:email'); }
        close('shopify');
        return { status: shopify, exitCode: shopify === 'ok' ? 0 : 32 };
      },
    },
  };
  return { d, log, dir, maxBrowsers: () => maxBrowsers };
}

test('C7 collector: ShipStation first, Shopify requested next, ShipStation uploaded during the email wait, never two browsers', async () => {
  const r = rig();
  const out = await runWeeklyCollection(r.d);
  assert.deepEqual([out.status, out.exitCode, out.sources], ['ok', 0, { shipping_cost_report: 'ok', shopify: 'ok' }]);
  assert.deepEqual(r.log, ['shipstation:open', 'shipstation:close', 'shopify:open', 'shopify:requested', 'shipstation:upload(1 browser open)',
    'shopify:waiting→shipstation ok', 'shopify:email', 'shopify:close']);
  assert.equal(r.maxBrowsers(), 1, 'the two Playwright jobs never overlap');
  assert.equal(fs.existsSync(r.d.lockFile), false, 'lock released');
  assert.deepEqual(JSON.parse(fs.readFileSync(r.d.stateFile, 'utf8'))[week.weekStart].shopify, 'ok');
});

test('C7 collector: a direct Shopify download (no email) still uploads ShipStation, right after', async () => {
  const r = rig({ emailed: false });
  const out = await runWeeklyCollection(r.d);
  assert.equal(out.status, 'ok');
  assert.deepEqual(r.log.slice(-1), ['shipstation:upload(0 browser open)']);
});

test('C7 collector: sources are independent — one failing never blocks the other', async () => {
  const a = rig({ ssUpload: 'upload_failed' });
  const oa = await runWeeklyCollection(a.d);
  assert.deepEqual([oa.status, oa.exitCode, oa.sources], ['partial', EXIT.PARTIAL, { shipping_cost_report: 'upload_failed (exit 31)', shopify: 'ok' }]);
  const b = rig({ shopify: 'export_email_timeout' });
  const ob = await runWeeklyCollection(b.d);
  assert.deepEqual(ob.sources, { shipping_cost_report: 'ok', shopify: 'export_email_timeout (exit 32)' });
  const c = rig({ ssStatus: 'needs_2fa' });
  const oc = await runWeeklyCollection(c.d);
  assert.deepEqual(oc.sources, { shipping_cost_report: 'needs_2fa (exit 20)', shopify: 'ok' });
  assert.ok(!c.log.some(l => l.startsWith('shipstation:upload')));
});

test('C7 collector: catch-up after a missed start collects only what the Worker still lacks', async () => {
  const done = rig({ collected: { shopify: 'ok', shopify_updates: 'ok', shipping_cost_report: 'ok' } });
  const o1 = await runWeeklyCollection(done.d);
  assert.deepEqual([o1.status, done.log], ['already_collected', []], 'restart after a successful week does nothing');
  const onlyShopify = rig({ collected: { shopify: 'missing', shopify_updates: 'missing', shipping_cost_report: 'ok' } });
  await runWeeklyCollection(onlyShopify.d);
  assert.ok(!onlyShopify.log.some(l => l.startsWith('shipstation')), 'the report already arrived');
  assert.ok(onlyShopify.log.includes('shopify:requested'));
  const onlyReport = rig({ collected: { shopify: 'ok', shopify_updates: 'ok', shipping_cost_report: 'missing' } });
  await runWeeklyCollection(onlyReport.d);
  assert.ok(!onlyReport.log.some(l => l.startsWith('shopify')));
  assert.ok(onlyReport.log.includes('shipstation:upload(0 browser open)'));
  // Worker unreachable: the local record decides; nothing is skipped that was not delivered.
  const offline = rig({ planDown: true });
  const oo = await runWeeklyCollection(offline.d);
  assert.equal(oo.status, 'ok');
  const again = await runWeeklyCollection({ ...offline.d, shipstation: { collect: async () => assert.fail('re-exported'), upload: async () => assert.fail() }, shopify: { run: async () => assert.fail('re-exported') } });
  assert.equal(again.status, 'already_collected');
});

test('C7 collector: a week that has not closed is never collected; a second instance is refused; a stale lock is replaced', async () => {
  const early = rig();
  assert.equal((await runWeeklyCollection({ ...early.d, week: { ...week, closed: false } })).status, 'week_not_closed');
  assert.deepEqual(early.log, []);
  const r = rig();
  assert.equal(acquireLock(r.d.lockFile), true);
  assert.equal((await runWeeklyCollection(r.d)).status, 'already_running');
  assert.deepEqual(r.log, []);
  const past = new Date(Date.now() - LOCK_STALE_MS - 60_000);
  fs.utimesSync(r.d.lockFile, past, past);
  assert.equal((await runWeeklyCollection(r.d)).status, 'ok', 'a crashed run’s lock does not block forever');
  releaseLock(r.d.lockFile);
});

test('C7 collector: the example config holds no credentials and names separate collector configs', () => {
  const ex = JSON.parse(fs.readFileSync(new URL('../automation/collector/config.example.json', import.meta.url), 'utf8'));
  assert.notEqual(ex.shipstationConfig, ex.shopifyConfig);
  assert.ok(!/password|secret|token/i.test(JSON.stringify(Object.keys(ex))));
});
