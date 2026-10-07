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

test('C7 collector: a source job that throws (the browser cannot start) fails only that source; the other source and compute still run', async () => {
  const r = rig();
  r.d.shipstation.collect = async () => { throw new Error('browserType.launchPersistentContext: spawn UNKNOWN'); };
  let computed = false;
  r.d.compute = async () => { computed = true; return { status: 'ok' }; };
  const out = await runWeeklyCollection(r.d);
  assert.equal(out.exitCode, EXIT.PARTIAL);
  assert.equal(out.sources.shipping_cost_report, 'failed (exit 30)');
  assert.equal(out.sources.shopify, 'ok');
  assert.equal(computed, true);
  const t = rig();
  t.d.shopify.run = async () => { throw Object.assign(new Error('x'), { exitCode: 23 }); };
  const o2 = await runWeeklyCollection(t.d);
  assert.deepEqual([o2.sources.shipping_cost_report, o2.sources.shopify], ['ok', 'failed (exit 23)'], 'a pending ShipStation upload still happens');
  assert.equal(fs.existsSync(t.d.lockFile), false, 'the lock is released');
});

test('C7 collector: catch-up after a missed start collects only what the Worker still lacks', async () => {
  const done = rig({ collected: { shopify: 'ok', shopify_updates: 'ok', shipping_cost_report: 'ok' } });
  const o1 = await runWeeklyCollection(done.d);
  assert.deepEqual([o1.status, done.log], ['already_collected', []], 'restart after a successful week opens no browser');
  // Free-tier path: the restart still runs the (idempotent) compute step, so weeks unblocked since are computed.
  let computed = 0;
  const ft = rig({ collected: { shopify: 'ok', shopify_updates: 'ok', shipping_cost_report: 'ok' } });
  const o3 = await runWeeklyCollection({ ...ft.d, compute: async () => { computed++; return { status: 'ok' }; } });
  assert.deepEqual([o3.status, o3.exitCode, computed, ft.log], ['already_collected', EXIT.OK, 1, []]);
  const o4 = await runWeeklyCollection({ ...rig({ collected: { shopify: 'ok', shopify_updates: 'ok', shipping_cost_report: 'ok' } }).d, compute: async () => ({ status: 'partial' }) });
  assert.deepEqual([o4.status, o4.exitCode], ['partial', EXIT.PARTIAL]);
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

test('collector: Shopify sign-in that needs a person — ShipStation kept first, the status says so, retries wait for the person and then finish', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-orch-'));
  const log = [], events = [];
  let collected = { shopify: 'missing', shopify_updates: 'missing', shipping_cost_report: 'missing' }, signedIn = false, computes = 0;
  const d = {
    week, lockFile: path.join(dir, 'collector.lock'), stateFile: path.join(dir, 'state.json'),
    weekPlan: async () => ({ weekStart: week.weekStart, collected }),
    shipstation: {
      collect: async () => { log.push('shipstation:collect'); return { status: 'prepared', pending: { sanitized: true } }; },
      upload: async () => { log.push('shipstation:upload'); collected = { ...collected, shipping_cost_report: 'ok' }; return { status: 'ok', exitCode: 0 }; },
    },
    shopify: {
      run: async ({ onSignInRequired, onSignedIn }) => {
        log.push('shopify:open');
        await onSignInRequired({ state: 'two_factor_required', since: '2026-09-21T08:10:00Z', waitMinutes: 30 });
        if (!signedIn) return { status: 'needs_2fa', exitCode: 20 };     // nobody signed in during the wait
        await onSignedIn({ since: '2026-09-21T08:10:00Z' });
        log.push('shopify:export');
        collected = { ...collected, shopify: 'ok', shopify_updates: 'ok' };
        return { status: 'ok', exitCode: 0 };
      },
    },
    signInEvent: async (status, detail) => { events.push([status, detail?.authState ?? null]); },
    compute: async () => { computes++; return { status: 'ok' }; },
  };
  // Attempt 1: the ShipStation report is uploaded BEFORE the wait for the person; the week computes what it can.
  const a = await runWeeklyCollection(d);
  assert.deepEqual([a.status, a.exitCode], ['signin_required', EXIT.SIGNIN_REQUIRED]);
  assert.deepEqual(log, ['shipstation:collect', 'shopify:open', 'shipstation:upload']);
  assert.deepEqual(events, [['needs_person', 'two_factor_required']]);
  assert.equal(a.sources.shipping_cost_report, 'ok');
  assert.equal(computes, 1);
  // Attempt 2: nothing exported again; still waiting — no compute (no D1 reads for nothing).
  log.length = 0;
  const b = await runWeeklyCollection(d);
  assert.deepEqual([b.exitCode, b.compute], [EXIT.SIGNIN_REQUIRED, { status: 'skipped', code: 'shopify_signin_required' }]);
  assert.deepEqual(log, ['shopify:open'], 'ShipStation is not collected twice');
  assert.equal(computes, 1);
  // Attempt 3: the person signs in in the open window; the same run continues the export and finishes.
  signedIn = true; log.length = 0; events.length = 0;
  const c = await runWeeklyCollection(d);
  assert.deepEqual([c.status, c.exitCode], ['ok', EXIT.OK]);
  assert.deepEqual(log, ['shopify:open', 'shopify:export']);
  assert.deepEqual(events.map(e => e[0]), ['needs_person', 'signed_in']);
  assert.equal(computes, 2);
});

test('APS mapping: runs after the Shipping Cost Report with its rows, one browser at a time; never changes the exit code', async () => {
  const r = rig();
  r.d.shipstation.collect = async () => ({ status: 'prepared', pending: { sanitized: true, prep: { sanitizedText: 'SCR',
    payload: { sanitizedSha256: 'e'.repeat(64), requestedFrom: '2026-07-27', requestedTo: '2026-09-20' } } } });
  const calls = [];
  r.d.apsMapping = { needed: async () => { calls.push('needed'); return false; },
    run: async ({ scrText, scrSource }) => { calls.push(`run:${scrText}`); calls.push(scrSource); r.log.push('aps:export'); return { status: 'ok', apsOrders: 3 }; } };
  const out = await runWeeklyCollection(r.d);
  assert.deepEqual([out.status, out.exitCode, out.aps], ['ok', 0, { status: 'ok', apsOrders: 3 }]);
  assert.deepEqual(calls, ['run:SCR', { sanitizedSha256: 'e'.repeat(64), from: '2026-07-27', to: '2026-09-20' }], 'with this run’s report rows and their provenance; no coverage question needed');
  assert.ok(r.log.indexOf('aps:export') < r.log.indexOf('shopify:open'), 'before the Shopify browser opens');
  // A failure (e.g. steps not recorded) is reported, never a partial week.
  const f = rig();
  f.d.shipstation.collect = async () => ({ status: 'prepared', pending: { sanitized: true, prep: { sanitizedText: 'SCR' } } });
  f.d.apsMapping = { needed: async () => true, run: async () => ({ status: 'aps_mapping_not_configured' }) };
  const of = await runWeeklyCollection(f.d);
  assert.deepEqual([of.status, of.exitCode, of.aps.status], ['ok', 0, 'aps_mapping_not_configured']);
  // A crash in the step is contained too.
  const c = rig();
  c.d.apsMapping = { needed: async () => true, run: async () => { throw new Error('browser'); } };
  const oc = await runWeeklyCollection(c.d);
  assert.deepEqual([oc.status, oc.aps.status], ['ok', 'failed']);
});

test('APS mapping: when the sources are already in, it runs only if the stored mapping does not cover the week', async () => {
  const done = { shopify: 'ok', shopify_updates: 'ok', shipping_cost_report: 'ok' };
  const a = rig({ collected: done });
  let ran = 0;
  a.d.apsMapping = { needed: async () => false, run: async () => { ran++; return { status: 'ok' }; } };
  const oa = await runWeeklyCollection(a.d);
  assert.deepEqual([oa.status, oa.aps, ran], ['already_collected', { status: 'covered' }, 0]);
  const b = rig({ collected: done });
  b.d.apsMapping = { needed: async () => true, run: async ({ scrText }) => { ran++; return { status: 'ok', scrText }; } };
  const ob = await runWeeklyCollection(b.d);
  assert.deepEqual([ob.status, ob.aps, ran], ['already_collected', { status: 'ok', scrText: null }, 1]);
});
