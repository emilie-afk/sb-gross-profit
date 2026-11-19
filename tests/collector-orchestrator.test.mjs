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
import { runWeeklyCollection, EXIT } from '../automation/collector/src/orchestrate.mjs';
import { memoryRunLock } from './helpers/memoryRunLock.mjs';
const TEST_LOCK = memoryRunLock();   // no sockets: orchestration tests also run where local binds are refused

const week = { weekStart: '2026-09-14', weekEnd: '2026-09-20', closed: true };
function rig({ collected = { shopify: 'missing', shopify_updates: 'missing', shipping_cost_report: 'missing' }, planDown = false,
               ssStatus = 'prepared', ssUpload = 'ok', shopify = 'ok', emailed = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-orch-'));
  const log = [];
  let browsers = 0, maxBrowsers = 0;
  const open = name => { browsers++; maxBrowsers = Math.max(maxBrowsers, browsers); log.push(`${name}:open`); };
  const close = name => { browsers--; log.push(`${name}:close`); };
  const d = {
    week, lockFile: path.join(dir, 'collector.lock'), runLock: TEST_LOCK, stateFile: path.join(dir, 'state.json'),
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
  assert.equal(TEST_LOCK.isHeld(r.d.lockFile), false, 'lock released');
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
  assert.equal(TEST_LOCK.isHeld(t.d.lockFile), false, 'the lock is released');
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

test('C7 collector: a week that has not closed is never collected; a second instance is refused; the lock is released after the run', async () => {
  const early = rig();
  assert.equal((await runWeeklyCollection({ ...early.d, week: { ...week, closed: false } })).status, 'week_not_closed');
  assert.deepEqual(early.log, []);
  const r = rig();
  const held = await TEST_LOCK.acquire(r.d.lockFile);
  assert.ok(held);
  assert.equal((await runWeeklyCollection(r.d)).status, 'already_running');
  assert.deepEqual(r.log, []);
  assert.equal(await TEST_LOCK.release(held), true);
  assert.equal((await runWeeklyCollection(r.d)).status, 'ok');
  assert.equal(TEST_LOCK.isHeld(r.d.lockFile), false, 'released after the run');
});

test('C7 collector: the run lock is released when a step throws', async () => {
  const r = rig();
  r.d.compute = async () => { throw new Error('boom'); };
  await runWeeklyCollection(r.d);
  assert.equal(TEST_LOCK.isHeld(r.d.lockFile), false);
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
    week, lockFile: path.join(dir, 'collector.lock'), runLock: TEST_LOCK, stateFile: path.join(dir, 'state.json'),
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

// ── Mid-week Shipping Cost Report refresh ───────────────────────────────────────────────────────────
import { midweekReportDue } from '../automation/collector/src/orchestrate.mjs';
import { versionReviewReasons } from '../shared/scrDays.js';

const pick = m => m && { to: m.to, status: m.status, reportStatus: m.reportStatus, versionId: m.versionId };
const LOW = { shipStationCoverage: { required: 200, valid: 130 } };          // 65%: below the 95% gate
const THU_0720_ICT = Date.parse('2026-09-24T00:20:00Z');                      // Wed 17:20 in Los Angeles
const TUE_0720_ICT = Date.parse('2026-09-22T00:20:00Z');                      // Mon 17:20 in Los Angeles
const WED_0720_ICT = Date.parse('2026-09-23T00:20:00Z');                      // Tue 17:20 in Los Angeles

test('mid-week refresh: due from Wednesday (report time zone) while the closed week is unpublished and not known to pass the coverage gate, through yesterday', () => {
  const due = now => midweekReportDue({ week, entry: LOW, now });
  assert.equal(due(TUE_0720_ICT), null, 'Monday there: nothing after Sunday is complete yet');
  assert.equal(due(WED_0720_ICT), null, 'Tuesday there: only Monday is complete');
  assert.equal(due(THU_0720_ICT), '2026-09-22', 'Wednesday there: ship dates through Tuesday');
  assert.equal(midweekReportDue({ week, entry: { shipStationCoverage: { required: 100, valid: 95 } }, now: THU_0720_ICT }), null, 'at the gate: not needed');
  assert.equal(midweekReportDue({ week, entry: {}, now: THU_0720_ICT }), '2026-09-22', 'coverage unknown on this PC (computed before it was recorded): still refreshed');
  assert.equal(midweekReportDue({ week, entry: {}, now: THU_0720_ICT, published: true }), null, 'a published week needs no refresh');
  assert.equal(midweekReportDue({ week, entry: LOW, now: THU_0720_ICT, published: true }), null);
  assert.equal(midweekReportDue({ week, entry: { shipStationCoverage: { required: 0, valid: 0 } }, now: THU_0720_ICT }), null);
  assert.equal(midweekReportDue({ week, entry: { ...LOW, midweekReport: { to: '2026-09-22', status: 'ok' } }, now: THU_0720_ICT }), null, 'once per closed week');
  assert.equal(midweekReportDue({ week, entry: LOW, now: THU_0720_ICT, threshold: 0.6 }), null, 'threshold from config');
});

test('mid-week refresh: its last ship date is never the export date, so the Worker does not refuse it as incomplete', () => {
  const to = midweekReportDue({ week, entry: LOW, now: THU_0720_ICT });
  const reasons = versionReviewReasons({ flags: {}, firstVersion: false, coverage: { from: '2026-07-27', to: '2026-09-20' }, from: '2026-07-27', to,
                                         exportedAt: new Date(THU_0720_ICT + 5 * 60_000).toISOString(), timeZone: 'America/Los_Angeles' });
  assert.ok(!reasons.includes('possible_incomplete_trailing_date'), reasons.join(','));
});

const ADDED = { '2026-09-21': 'h21', '2026-09-22': 'h22' };                  // the refresh's dates after the closed week
function midweekRig({ entry = LOW, ssStatus = 'prepared', now = THU_0720_ICT, draftStatus = 'blocked',
                      report = { status: 'accepted', versionId: 'scr_1', addedDayHashes: ADDED }, reportState = 'accepted' } = {}) {
  const r = rig({ collected: { shopify: 'ok', shopify_updates: 'ok', shipping_cost_report: 'ok' }, ssStatus });
  const uploads = [];
  r.d.shipstation.upload = async () => { uploads.push(1); return { status: 'ok', exitCode: 0, report }; };   // HTTP 200 in every case
  const checks = [];
  r.d.midweekReportState = async rec => { checks.push(rec); return typeof reportState === 'function' ? reportState(rec) : reportState; };
  r.d.weekPlan = async () => ({ weekStart: week.weekStart, collected: { shopify: 'ok', shopify_updates: 'ok', shipping_cost_report: 'ok' }, draftStatus });
  fs.writeFileSync(r.d.stateFile, JSON.stringify({ [week.weekStart]: { shipping_cost_report: 'ok', shopify: 'ok', ...entry } }));
  const calls = [];
  const collect = r.d.shipstation.collect;
  r.d.shipstation.collect = async (o) => { calls.push(o); return collect(o); };
  r.d.midweek = { timeZone: 'America/Los_Angeles', threshold: 0.95 };
  r.d.now = () => now;
  const computes = [];
  r.d.compute = async ({ sources }) => { computes.push(sources); return { status: 'ok', weeks: [{ weekStart: week.weekStart, status: 'computed', shipStationCoverage: { required: 200, valid: 196 } }] }; };
  return { ...r, calls, computes, uploads, checks, state: () => JSON.parse(fs.readFileSync(r.d.stateFile, 'utf8'))[week.weekStart] };
}

test('mid-week refresh: a due run exports the report through yesterday, uploads it, recomputes and records it once', async () => {
  const r = midweekRig();
  const out = await runWeeklyCollection(r.d);
  assert.deepEqual([out.status, out.exitCode, out.sources], ['ok', 0, { shipping_cost_report: 'ok', shopify: 'ok' }]);
  assert.deepEqual(r.calls, [{ reportTo: '2026-09-22' }]);
  assert.ok(!r.log.some(l => l.startsWith('shopify:')), 'Shopify is already in: no Shopify browser');
  assert.equal(r.computes.length, 1);
  assert.deepEqual(pick(r.state().midweekReport), { to: '2026-09-22', status: 'ok', reportStatus: 'accepted', versionId: 'scr_1' });
  assert.deepEqual(r.checks, [{ versionId: 'scr_1', dayHashes: ADDED }], 'acceptance read from the Worker for this version\'s added dates');
  assert.deepEqual(r.state().shipStationCoverage, { required: 200, valid: 196 }, 'the recomputed coverage is remembered');
  const again = await runWeeklyCollection(r.d);
  assert.equal(again.status, 'already_collected');
  assert.equal(r.calls.length, 1, 'never a second refresh for the same closed week');
});

test('mid-week refresh: a refresh that fails is not recorded, so the next start tries again', async () => {
  const r = midweekRig({ ssStatus: 'signin_blocked' });
  r.d.compute = async () => ({ status: 'ok', weeks: [{ weekStart: week.weekStart, status: 'unchanged' }] });   // nothing new arrived
  const out = await runWeeklyCollection(r.d);
  assert.equal(out.exitCode, EXIT.PARTIAL);
  assert.equal(r.state().midweekReport, undefined);
  assert.equal(midweekReportDue({ week, entry: r.state(), now: THU_0720_ICT }), '2026-09-22');
});

test('mid-week refresh: not due before Wednesday, above the gate, once published, or without d.midweek: no ShipStation browser', async () => {
  for (const [label, opts, off] of [['Tuesday ICT', { now: TUE_0720_ICT }], ['above the gate', { entry: { shipStationCoverage: { required: 100, valid: 99 } } }],
                                    ['published', { draftStatus: 'published' }], ['off', {}, true]]) {
    const r = midweekRig(opts);
    if (off) delete r.d.midweek;
    const out = await runWeeklyCollection(r.d);
    assert.equal(out.status, 'already_collected', label);
    assert.deepEqual(r.calls, [], label);
  }
});

test('mid-week refresh: the compute-only path remembers the closed week coverage for a later start', async () => {
  const r = midweekRig({ entry: {}, now: TUE_0720_ICT });
  r.d.compute = async () => ({ status: 'ok', weeks: [{ weekStart: week.weekStart, status: 'computed', shipStationCoverage: { required: 200, valid: 130 } },
                                                     { weekStart: '2026-09-07', status: 'computed', shipStationCoverage: { required: 10, valid: 1 } }] });
  await runWeeklyCollection(r.d);
  assert.deepEqual(r.state().shipStationCoverage, { required: 200, valid: 130 }, 'only the closed week is recorded');
  assert.equal(midweekReportDue({ week, entry: r.state(), now: THU_0720_ICT }), '2026-09-22');
});

test('recovery start: a due mid-week refresh is unfinished work; the Worker check and budget still decide first', async () => {
  const { recoveryDecision } = await import('../automation/collector/src/orchestrate.mjs');
  const ok = { unfinished: [], budget: { state: 'ok' } };
  assert.deepEqual(recoveryDecision(ok), { exitCode: 0, message: 'recovery: nothing unfinished (exit 0)' });
  assert.deepEqual(recoveryDecision(ok, ['midweek_shipping_report']), { exitCode: null, message: 'recovery: resuming midweek_shipping_report' });
  assert.equal(recoveryDecision({ unfinished: [], budget: { state: 'defer', reasons: ['d1_rows_written'] } }, ['midweek_shipping_report']).exitCode, EXIT.DEFERRED);
  assert.equal(recoveryDecision({ unfinished: [], budget: { state: 'unknown' } }, ['midweek_shipping_report']).exitCode, EXIT.PARTIAL);
  assert.equal(recoveryDecision(null, ['midweek_shipping_report']).exitCode, EXIT.PARTIAL, 'a failed check is never "nothing to do"');
  assert.equal(recoveryDecision({ unfinished: ['verification_backlog'], budget: { state: 'ok' } }).exitCode, null);
});

test('mid-week refresh: a week computed before this PC recorded its coverage (no record) is still refreshed while unpublished', async () => {
  const r = midweekRig({ entry: {} });
  const out = await runWeeklyCollection(r.d);
  assert.equal(out.status, 'ok');
  assert.deepEqual(r.calls, [{ reportTo: '2026-09-22' }]);
  assert.deepEqual(pick(r.state().midweekReport), { to: '2026-09-22', status: 'ok', reportStatus: 'accepted', versionId: 'scr_1' });
});

test('mid-week refresh: HTTP 200 with a REJECTED report is not completion; a later start exports it again', async () => {
  const r = midweekRig({ report: { status: 'rejected', versionId: 'scr_bad', addedDayHashes: ADDED }, reportState: 'rejected' });
  r.d.compute = async () => ({ status: 'ok', weeks: [{ weekStart: week.weekStart, status: 'unchanged' }] });   // nothing new was accepted
  const out = await runWeeklyCollection(r.d);
  assert.equal(out.sources.shipping_cost_report, 'ok', 'the upload itself succeeded (HTTP 200)');
  assert.deepEqual(pick(r.state().midweekReport), { to: '2026-09-22', status: 'rejected', reportStatus: 'rejected', versionId: 'scr_bad' });
  assert.deepEqual(r.checks, [], 'a report the Worker rejected needs no further reading');
  assert.equal(midweekReportDue({ week, entry: r.state(), now: THU_0720_ICT }), '2026-09-22', 'still due');
  await runWeeklyCollection(r.d);
  assert.equal(r.calls.length, 2, 'exported again by the next start');
});

test('mid-week refresh: a report held for review is tracked, never uploaded again, and completed once its added dates are accepted', async () => {
  let worker = 'awaiting';
  const r = midweekRig({ report: { status: 'pending_review', versionId: 'scr_2', addedDayHashes: ADDED }, reportState: () => worker });
  await runWeeklyCollection(r.d);
  assert.equal(r.state().midweekReport.status, 'awaiting');
  assert.deepEqual(r.state().midweekReport.dayHashes, ADDED);
  assert.equal(midweekReportDue({ week, entry: r.state(), now: THU_0720_ICT }), null, 'not due while it waits');
  await runWeeklyCollection(r.d);                                      // still in review
  assert.deepEqual([r.calls.length, r.uploads.length, r.state().midweekReport.status], [1, 1, 'awaiting']);
  worker = 'accepted';                                                 // a person accepted it
  await runWeeklyCollection(r.d);
  assert.deepEqual([r.calls.length, r.uploads.length, r.state().midweekReport.status], [1, 1, 'ok']);
  assert.ok(r.state().midweekReport.acceptedAt);
});

test('mid-week refresh: the Worker\'s per-date state decides, whatever the version status says', async () => {
  for (const status of ['partially_accepted', 'accepted', 'pending_review']) {
    for (const [state, record] of [['awaiting', 'awaiting'], ['accepted', 'ok'], ['rejected', 'rejected'], ['unknown', 'awaiting']]) {
      const r = midweekRig({ report: { status, versionId: 'scr_3', addedDayHashes: ADDED }, reportState: state });
      r.d.compute = async () => ({ status: 'ok', weeks: [{ weekStart: week.weekStart, status: 'unchanged' }] });
      await runWeeklyCollection(r.d);
      assert.equal(r.state().midweekReport.status, record, `${status} + ${state}`);
    }
  }
});

test('mid-week refresh: held for review, then REJECTED by a person → the next run exports a fresh report', async () => {
  let worker = 'awaiting', version = 0;
  const r = midweekRig({ reportState: rec => (rec.versionId === 'scr_held' ? worker : 'accepted') });
  r.d.shipstation.upload = async () => { r.uploads.push(1); version++;
    return { status: 'ok', exitCode: 0, report: { status: version === 1 ? 'pending_review' : 'accepted', versionId: version === 1 ? 'scr_held' : 'scr_fresh', addedDayHashes: ADDED } }; };
  r.d.compute = async () => ({ status: 'ok', weeks: [{ weekStart: week.weekStart, status: 'unchanged' }] });
  await runWeeklyCollection(r.d);                                      // upload held for review
  assert.deepEqual([r.state().midweekReport.status, r.state().midweekReport.versionId], ['awaiting', 'scr_held']);
  await runWeeklyCollection(r.d);                                      // still in review: nothing exported or uploaded
  assert.deepEqual([r.calls.length, r.uploads.length], [1, 1]);
  worker = 'rejected';                                                 // an admin rejects the held dates
  await runWeeklyCollection(r.d);                                      // next run: re-reads the version, then exports afresh
  assert.deepEqual([r.calls.length, r.uploads.length], [2, 2], 'a fresh report is exported and uploaded');
  assert.deepEqual(r.calls[1], { reportTo: '2026-09-22' });
  assert.deepEqual([r.state().midweekReport.status, r.state().midweekReport.versionId], ['ok', 'scr_fresh']);
  await runWeeklyCollection(r.d);
  assert.deepEqual([r.calls.length, r.uploads.length], [2, 2], 'done: no further refresh');
});

test('mid-week refresh: an upload without the Worker\'s report status records nothing (exported again later)', async () => {
  const r = midweekRig({ report: null });
  r.d.compute = async () => ({ status: 'ok', weeks: [{ weekStart: week.weekStart, status: 'unchanged' }] });   // nothing new was accepted
  await runWeeklyCollection(r.d);
  assert.equal(r.state().midweekReport, undefined);
  assert.equal(midweekReportDue({ week, entry: r.state(), now: THU_0720_ICT }), '2026-09-22');
});

// ── Recovery start (weekly done marker written → --recovery) with a saved mid-week refresh ──────────
import { recoveryStart } from '../automation/collector/src/orchestrate.mjs';

function recoveryRig({ record = { to: '2026-09-22', status: 'awaiting', versionId: 'scr_held', dayHashes: ADDED }, worker = 'awaiting',
                       work = { unfinished: [], budget: { state: 'ok' } }, draftStatus = 'blocked' } = {}) {
  // The PC after the Monday run finished (done marker written): the week's sources are in, the refresh waits for review.
  const r = midweekRig({ entry: { midweekReport: record } });
  const reads = [];
  const opts = {
    work: async () => { if (work instanceof Error) throw work; return work; }, week, closed: true,
    midweek: { timeZone: 'America/Los_Angeles', threshold: 0.95 }, stateFile: r.d.stateFile, lockFile: r.d.lockFile, runLock: TEST_LOCK, now: THU_0720_ICT,
    readReportState: async rec => { reads.push(rec); return worker; }, readPlan: async () => ({ draftStatus }),
  };
  return { ...r, reads, opts };
}

test('recovery start with an EMPTY Worker backlog: a refresh held then rejected by an admin is found and exported afresh', async () => {
  const r = recoveryRig({ worker: 'rejected' });
  const dec = await recoveryStart(r.opts);
  assert.deepEqual(dec, { exitCode: null, message: 'recovery: resuming midweek_shipping_report' }, 'the start does not exit');
  assert.deepEqual(r.reads, [{ versionId: 'scr_held', dayHashes: ADDED }], 'the saved version was re-read');
  assert.equal(r.state().midweekReport.status, 'rejected');
  assert.deepEqual([r.calls.length, r.uploads.length], [0, 0], 'the check itself exports and uploads nothing');
  // run.mjs then runs the collection (recoveryExit null): the fresh report is exported and uploaded.
  r.d.compute = async () => ({ status: 'ok', weeks: [{ weekStart: week.weekStart, status: 'unchanged' }] });
  const out = await runWeeklyCollection(r.d);
  assert.equal(out.sources.shipping_cost_report, 'ok');
  assert.deepEqual(r.calls, [{ reportTo: '2026-09-22' }]);
  assert.equal(r.uploads.length, 1);
  assert.equal(r.state().midweekReport.status, 'ok', 'the fresh report (accepted) completes the refresh');
});

test('recovery start: while the saved refresh is still in review the check is read-only and the start exits', async () => {
  const r = recoveryRig({ worker: 'awaiting' });
  assert.deepEqual(await recoveryStart(r.opts), { exitCode: EXIT.OK, message: 'recovery: nothing unfinished (exit 0)' });
  assert.equal(r.reads.length, 1, 'checked');
  assert.equal(r.state().midweekReport.status, 'awaiting');
  assert.deepEqual([r.calls.length, r.uploads.length], [0, 0]);
  const unknown = recoveryRig({ worker: 'unknown' });
  assert.equal((await recoveryStart(unknown.opts)).exitCode, EXIT.OK, 'no per-date outcomes: keeps waiting');
  assert.equal(unknown.state().midweekReport.status, 'awaiting');
});

test('recovery start: accepted after review is recorded done; the start exits', async () => {
  const r = recoveryRig({ worker: 'accepted' });
  assert.equal((await recoveryStart(r.opts)).exitCode, EXIT.OK);
  assert.equal(r.state().midweekReport.status, 'ok');
  assert.ok(r.state().midweekReport.acceptedAt);
});

test('recovery start: the Worker check and budget still decide first; a published week needs no fresh export', async () => {
  const down = recoveryRig({ worker: 'rejected', work: new Error('unreachable') });
  assert.equal((await recoveryStart(down.opts)).exitCode, EXIT.PARTIAL);
  assert.equal(down.reads.length, 0, 'nothing local is read when the Worker check fails');
  const deferred = recoveryRig({ worker: 'rejected', work: { unfinished: [], budget: { state: 'defer', reasons: ['d1_rows_written'] } } });
  assert.equal((await recoveryStart(deferred.opts)).exitCode, EXIT.DEFERRED);
  const published = recoveryRig({ worker: 'rejected', draftStatus: 'published' });
  assert.equal((await recoveryStart(published.opts)).exitCode, EXIT.OK);
  assert.equal(published.state().midweekReport.status, 'rejected', 'recorded, but no export for a published week');
  const off = recoveryRig({ worker: 'rejected' });
  assert.equal((await recoveryStart({ ...off.opts, midweek: null })).exitCode, EXIT.OK, 'refresh turned off');
  assert.equal(off.reads.length, 0);
});

test('recovery start: with the day\'s budget used up it stops (42) BEFORE any report-status call, even with an empty backlog', async () => {
  for (const [budget, code] of [[{ state: 'defer', reasons: ['d1_rows_written'] }, EXIT.DEFERRED], [{ state: 'unknown' }, EXIT.PARTIAL]]) {
    const r = recoveryRig({ worker: 'rejected', work: { unfinished: [], budget } });
    const dec = await recoveryStart(r.opts);
    assert.equal(dec.exitCode, code, JSON.stringify(dec));
    assert.match(dec.message, /midweek_report_review/);
    assert.equal(r.reads.length, 0, 'the saved report was not polled');
    assert.equal(r.state().midweekReport.status, 'awaiting', 'state untouched');
    assert.equal(TEST_LOCK.isHeld(r.d.lockFile), false);
  }
  // Nothing pending on this PC: an empty backlog still exits 0 whatever the budget.
  const idle = recoveryRig({ record: { to: '2026-09-22', status: 'ok', versionId: 'scr_done' }, work: { unfinished: [], budget: { state: 'defer' } } });
  assert.equal((await recoveryStart(idle.opts)).exitCode, EXIT.OK);
});

test('recovery start: the state update holds the collector lock, so a concurrent run\'s newer record is never overwritten', async () => {
  const newer = { to: '2026-09-22', status: 'ok', versionId: 'scr_newer', reportStatus: 'accepted' };
  const saveNewer = file => { const st = JSON.parse(fs.readFileSync(file, 'utf8')); st[week.weekStart].midweekReport = newer; fs.writeFileSync(file, JSON.stringify(st)); };
  // a) The reviewer's race: recovery has read the old 'awaiting' record; before it takes the lock, another run (holding
  //    the lock) saves a newer ACCEPTED record. Recovery reads state.json again under the lock: nothing to poll, nothing overwritten.
  const a = recoveryRig({ worker: 'rejected' });
  a.opts.runLock = { acquire: async (f, o) => { const h = await TEST_LOCK.acquire(f); await TEST_LOCK.release(h); saveNewer(a.d.stateFile); return TEST_LOCK.acquire(f, o); },
                     release: h => TEST_LOCK.release(h) };
  const decA = await recoveryStart(a.opts);
  assert.equal(decA.exitCode, EXIT.OK, JSON.stringify(decA));
  assert.deepEqual(a.state().midweekReport, newer, 'the newer accepted record is kept, not replaced by the older rejected one');
  assert.equal(a.reads.length, 0, 'no report-status call for a record that is no longer waiting');
  // b) Another run holds the lock now: recovery stops (exit 5) without polling or writing; that run owns the week.
  const b = recoveryRig({ worker: 'rejected' });
  const other = await TEST_LOCK.acquire(b.d.lockFile);
  assert.equal((await recoveryStart(b.opts)).exitCode, EXIT.ALREADY_RUNNING);
  assert.equal(b.reads.length, 0);
  assert.equal(b.state().midweekReport.status, 'awaiting', 'untouched');
  await TEST_LOCK.release(other);
  // c) Recovery holds the lock while it waits for the Worker: a run started meanwhile cannot write state.json.
  const c = recoveryRig({ worker: 'rejected' });
  let during = null;
  c.opts.readReportState = async rec => { c.reads.push(rec); during = await runWeeklyCollection(c.d); return 'rejected'; };
  const decC = await recoveryStart(c.opts);
  assert.equal(during.status, 'already_running', 'the concurrent run was kept out while recovery held the lock');
  assert.deepEqual([c.calls.length, c.uploads.length], [0, 0]);
  assert.equal(decC.exitCode, null);
  assert.equal(c.state().midweekReport.status, 'rejected');
  assert.equal(TEST_LOCK.isHeld(c.d.lockFile), false, 'released after the update');
});
