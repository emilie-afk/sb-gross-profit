/**
 * orchestrate.mjs — the ONE weekly collector on the Windows host (C7)
 * ===================================================================
 * Never runs two Playwright jobs at once. Order:
 *
 *   1. ShipStation Shipping Cost Report: browser A (its own profile) exports and
 *      sanitizes, then closes. The upload is deferred.
 *   2. Shopify: browser B (its own profile) requests the rolling export.
 *   3. While Shopify's email is pending, the ShipStation payload is uploaded
 *      (HTTP only). If Shopify downloaded directly or was skipped, it is uploaded
 *      right after instead.
 *   4. Gmail is polled and the sanitized Shopify export uploaded.
 *   5. Each source is reported to the Worker independently; one failing never
 *      blocks the other.
 *   6. Free-tier path (d.compute, optional): the week and every week whose inputs
 *      changed are computed here with the unchanged engine, uploaded, and sent to
 *      the independent verifier (freeTier.mjs).
 *
 * Catch-up: Task Scheduler also starts this at logon/startup and runs a missed
 * weekly start as soon as possible. The Worker's week plan (`collected`) says
 * which sources the last closed week still lacks; only those are collected, so
 * a repeat run never re-exports what already arrived. An OS-held run lock
 * (runLock.mjs) keeps two instances from overlapping and is released when the run's process exits.
 *
 * Pure orchestration: every side effect is injected (run.mjs wires the real ones).
 */
import fs from 'node:fs';
import path from 'node:path';
import { acquireRunLock, releaseRunLock } from './runLock.mjs';

/** SIGNIN_REQUIRED: everything else is done or partial, and Shopify still waits for a person to sign in (the task retries sooner). */
/** DEFERRED: the day's D1 budget is used up; nothing more is attempted until after 00:00 UTC (never "done"). */
export const EXIT = Object.freeze({ OK: 0, ALREADY_RUNNING: 5, NOT_DUE: 0, PARTIAL: 40, SIGNIN_REQUIRED: 41, DEFERRED: 42 });
/** Shopify outcomes that only a person can resolve (two-step code, human check). */
const SIGNIN_STATUSES = new Set(['needs_2fa', 'needs_human_captcha']);

/** Local record of what this PC delivered per week (sources and statuses only). */
export function loadState(file, fsImpl = fs) { try { return JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch { return {}; } }
export function saveState(file, state, fsImpl = fs) { fsImpl.mkdirSync(path.dirname(file), { recursive: true }); fsImpl.writeFileSync(file, JSON.stringify(state, null, 2)); }

const ymdIn = (ms, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const addDaysIso = (iso, n) => { const t = new Date(`${iso}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

/**
 * Mid-week Shipping Cost Report refresh. The Monday report ends on the closed week's Sunday, so that week's
 * orders shipped on Monday or later have no ShipStation cost until the next Monday's report, and the week stays
 * held below the coverage gate for a week. While the closed week is NOT published, ONE extra report is collected
 * per closed week, once ship dates through the Tuesday after the week are complete in the report's time zone
 * (Wednesday there; the Thursday 07:20 ICT start), ending on yesterday — a complete day: the Worker refuses a
 * report whose last ship date is the export date (possible_incomplete_trailing_date). It is skipped only when
 * this PC knows the week's ShipStation coverage already passes the gate (recorded from a compute); an unknown
 * coverage (e.g. the week was computed before this PC recorded it) does not prevent the refresh.
 * @param {{ weekEnd: string }} o.week                  the closed week
 * @param {object} o.entry                               this PC's state for the week (shipStationCoverage, midweekReport)
 * @param {boolean} [o.published]                        the Worker says the week's newest draft is published
 * @returns {string|null} the refresh report's last ship date (YYYY-MM-DD), or null when none is due
 */
export function midweekReportDue({ week, entry, now, timeZone = 'America/Los_Angeles', threshold = 0.95, published = false }) {
  if (published === true) return null;
  // 'ok': the added dates are accepted; 'awaiting': uploaded and held for review (never re-uploaded while it waits).
  // 'rejected' (refused by the Worker's checks) is due again.
  if (['ok', 'awaiting'].includes(entry?.midweekReport?.status)) return null;
  const cov = entry?.shipStationCoverage;
  if (cov && cov.required >= 0 && Number.isInteger(cov.valid) && (cov.required === 0 || cov.valid / cov.required + 1e-9 >= threshold)) return null;
  const yesterday = addDaysIso(ymdIn(now, timeZone), -1);
  if (yesterday < addDaysIso(week.weekEnd, 2)) return null;
  return yesterday;
}

/**
 * A recovery start (the week is already done on this PC): what the Worker's unfinished-work answer plus this
 * PC's own pending work (e.g. a mid-week report refresh) mean. `exitCode` null: go on with the run.
 * @param {{ unfinished?: string[], budget?: { state, reasons? } }|null} work   null: the check failed
 * @param {string[]} local   codes of work only this PC knows about
 */
export function recoveryDecision(work, local = []) {
  if (!work) return { exitCode: EXIT.PARTIAL, message: 'recovery: unfinished-work check unavailable (exit 40)' };
  const unfinished = [...(work.unfinished || []), ...local];
  if (!unfinished.length) return { exitCode: EXIT.OK, message: 'recovery: nothing unfinished (exit 0)' };
  if (work.budget?.state !== 'ok') return { exitCode: work.budget?.state === 'defer' ? EXIT.DEFERRED : EXIT.PARTIAL,
    message: `recovery: ${unfinished.join(', ')}; deferred (${(work.budget?.reasons || []).join(', ')})` };
  return { exitCode: null, message: `recovery: resuming ${unfinished.join(', ')}` };
}

/**
 * A recovery start (the Windows task already wrote the week's done marker, so it runs with --recovery): the Worker's
 * unfinished-work answer joins this PC's own pending work, so an empty Worker backlog never hides it.
 *   1. The Worker check failing → exit 40; nothing local is read.
 *   2. This PC's candidate work is found from state.json alone (no Worker call): a refresh waiting for review
 *      ('midweek_report_review') or a due refresh ('midweek_shipping_report').
 *   3. Without budget (defer → 42, unknown → 40) the start stops there, before any report-status call.
 *   4. With budget, under the collector run lock (the same lock every run holds while it writes state.json, so a
 *      concurrent run's newer record is never overwritten): state.json is read again, a refresh waiting for review is
 *      re-read from the Worker (read-only: nothing exported or uploaded), accepted → recorded 'ok', rejected in
 *      review → recorded 'rejected', which makes the refresh due; the file is written, the lock released. A due refresh
 *      (week not published) is unfinished work: the start resumes and exports a fresh report.
 *      Lock held by another run → exit 5: that run owns the week and re-reads the refresh itself.
 * @returns {Promise<{ exitCode: number|null, message: string }>}  null: go on with the run
 */
export async function recoveryStart({ work, week, closed, midweek = null, stateFile, lockFile, runLock = null, fsImpl = fs, now = Date.now(),
                                      readReportState = null, readPlan = null, log = () => {} }) {
  let wk = null;
  try { wk = await work(); } catch { wk = null; }
  if (!wk || !closed || !midweek) return recoveryDecision(wk);
  const candidates = entry => [
    ...(entry.midweekReport?.status === 'awaiting' ? ['midweek_report_review'] : []),
    ...(midweekReportDue({ week, entry, now, ...midweek }) ? ['midweek_shipping_report'] : []),
  ];
  const before = candidates(loadState(stateFile, fsImpl)[week.weekStart] || {});
  if (!before.length) return recoveryDecision(wk);
  if (wk.budget?.state !== 'ok') return recoveryDecision(wk, before);          // stop before any report-status call

  const lock = runLock || { acquire: acquireRunLock, release: releaseRunLock };
  const lockOpts = fsImpl !== fs ? { fsImpl } : {};
  const held = await lock.acquire(lockFile, { now, ...lockOpts });
  if (!held) return { exitCode: EXIT.ALREADY_RUNNING, message: 'recovery: another collector run holds the lock; it owns the week (exit 5)' };
  let due = null;
  try {
    const state = loadState(stateFile, fsImpl);                                  // read again under the lock
    const entry = state[week.weekStart] || {};
    if (await recheckAwaiting(entry, { midweekReportState: readReportState }, now, m => log(`recovery: ${m}`))) {
      state[week.weekStart] = entry;
      saveState(stateFile, state, fsImpl);
    }
    due = midweekReportDue({ week, entry, now, ...midweek });
  } finally {
    await lock.release(held, lockOpts);
  }
  if (due && readPlan) {                       // a published week needs no refresh; unknown (unreachable) counts as unpublished
    let plan = null;
    try { plan = await readPlan(); } catch { plan = null; }
    if (plan?.draftStatus === 'published') due = null;
  }
  return recoveryDecision(wk, due ? ['midweek_shipping_report'] : []);
}

/**
 * @param {object} d
 * @param {{ weekStart, weekEnd, closed: boolean }} d.week          the last closed reporting week
 * @param {() => Promise<{ collected: object, draftStatus?: string|null }|null>} d.weekPlan    Worker week plan (null when unreachable)
 * @param {{ collect: () => Promise<{status, exitCode, pending?}>, upload: (pending) => Promise<{status, exitCode}> }} d.shipstation
 * @param {{ run: ({ onWaiting, onSignInRequired, onSignedIn }) => Promise<{status, exitCode}> }} d.shopify
 * @param {(status: 'needs_person'|'signed_in', detail?: object) => Promise<void>} [d.signInEvent]  tells the Worker (shown on the status)
 * @param {() => Promise<{ state: 'ok'|'defer'|'unknown', resetAt?, reasons? }>} [d.budget]  the day's D1 budget (Free-tier path)
 * @param {{ needed: () => Promise<boolean>, run: ({ scrText }) => Promise<{ status, exitCode?, facts? }> }} [d.apsMapping]
 *        APS scenario input (the saved line-item export, mapping only). Runs after the Shipping Cost
 *        Report (its rows let split shipments be matched) or, when that is already in, only if the stored mapping
 *        does not cover the week. Its outcome never changes the run's exit code: a failed export is retried by
 *        the next run (its window starts where the stored mapping ends).
 * @param {{ timeZone?: string, threshold?: number }} [d.midweek]  mid-week Shipping Cost Report refresh (midweekReportDue); off when absent
 * @param {(rec: { versionId: string, dayHashes: Record<string, string> }) => Promise<'accepted'|'awaiting'|'rejected'|'unknown'>} [d.midweekReportState]
 *        where the uploaded refresh version's dates after the closed week stand, from the Worker's per-date outcomes
 *        (freeTier midweekReportState). An upload that returns 200 is not acceptance: the report can be rejected,
 *        held for review or partially accepted, and a person can later accept or reject what was held.
 * @param {string} d.lockFile
 * @param {{ acquire: (lockFile: string, o?: object) => Promise<object|null>, release: (handle: object, o?: object) => Promise<boolean> }} [d.runLock]
 *        the run lock; default: the OS-held lock of runLock.mjs (tests inject an in-memory lock)
 * @param {string} d.stateFile
 */
/**
 * A source job that throws (e.g. the browser cannot start) is that source's failure only: it is
 * reported with an exit code, and the other source and the compute step still run.
 */
export const SOURCE_CRASHED = 30;
async function guarded(job) {
  try { return await job(); }
  catch (e) { return { status: 'failed', exitCode: Number.isInteger(e?.exitCode) ? e.exitCode : SOURCE_CRASHED }; }
}

/**
 * What a mid-week refresh upload achieved, judged by the Worker's answer and then by the version's per-date
 * outcomes for its dates after the closed week (never by HTTP success):
 *   'ok'        those dates are accepted (in force): no further refresh for this week;
 *   'awaiting'  some are held for review: not uploaded again; every later start re-reads the version;
 *   'rejected'  the Worker refused it, or a person rejected held dates: a later start (or this one) exports afresh.
 * Without a Worker answer (no report status) nothing is recorded, so the next start exports again.
 */
const REPORT_STATE_TO_RECORD = { accepted: 'ok', awaiting: 'awaiting', unknown: 'awaiting', rejected: 'rejected' };
async function readMidweekState(d, rec) {
  if (!d.midweekReportState || !rec.versionId || !rec.dayHashes) return 'unknown';
  try { return await d.midweekReportState({ versionId: rec.versionId, dayHashes: rec.dayHashes }); } catch { return 'unknown'; }
}
/**
 * Re-read a refresh that waits for review (read-only: nothing is exported or uploaded while it waits).
 * Accepted → 'ok'; rejected in review → 'rejected' (the refresh is then due again). Returns true when `entry` changed.
 */
async function recheckAwaiting(entry, d, nowMs, log) {
  if (entry?.midweekReport?.status !== 'awaiting') return false;
  const st = await readMidweekState(d, entry.midweekReport);
  const next = REPORT_STATE_TO_RECORD[st] || 'awaiting';
  if (next === 'awaiting') { log(`mid-week report still in review (checked: ${st})`); return false; }
  entry.midweekReport = { ...entry.midweekReport, status: next, [next === 'ok' ? 'acceptedAt' : 'rejectedAt']: new Date(nowMs).toISOString() };
  log(`mid-week report ${next === 'ok' ? 'accepted after review' : 'rejected in review; a fresh one is exported when due'}`);
  return true;
}

async function midweekOutcome(to, report, d, log) {
  const at = new Date(d.now ? d.now() : Date.now()).toISOString();
  if (!report || typeof report.status !== 'string') return null;
  const dayHashes = report.addedDayHashes && Object.keys(report.addedDayHashes).length ? report.addedDayHashes : null;
  const base = { to, versionId: report.versionId || null, reportStatus: report.status, at, ...(dayHashes ? { dayHashes } : {}) };
  if (report.status === 'rejected') { log('shipstation: mid-week report rejected by the Worker; a later start exports it again'); return { ...base, status: 'rejected' }; }
  const state = await readMidweekState(d, base);
  log(`shipstation: mid-week report ${report.status}; added dates ${state}`);
  return { ...base, status: REPORT_STATE_TO_RECORD[state] || 'awaiting' };
}

export async function runWeeklyCollection(d) {
  const log = d.log || (() => {});
  if (!d.week.closed) return { status: 'week_not_closed', exitCode: EXIT.NOT_DUE, sources: {} };
  const lock = d.runLock || { acquire: acquireRunLock, release: releaseRunLock };
  const lockOpts = d.fs ? { fsImpl: d.fs } : {};
  const runLock = await lock.acquire(d.lockFile, { now: d.now ? d.now() : Date.now(), ...lockOpts });
  if (!runLock) return { status: 'already_running', exitCode: EXIT.ALREADY_RUNNING, sources: {} };
  const state = loadState(d.stateFile, d.fs);
  const mine = state[d.week.weekStart] || {};
  const sources = {};
  // The closed week's ShipStation expense coverage from a compute that recomputed it (counts only).
  const rememberCoverage = compute => {
    const row = (compute?.weeks || []).find(r => r.weekStart === d.week.weekStart && r.shipStationCoverage);
    if (!row) return;
    state[d.week.weekStart] = { ...(state[d.week.weekStart] || mine), shipStationCoverage: row.shipStationCoverage };
    saveState(d.stateFile, state, d.fs);
  };
  let aps;                                                             // { status, ... } when the APS mapping step ran
  const apsStep = async (scrText, scrPayload = null) => {
    if (!d.apsMapping) return;
    let needed = !!scrText;
    if (!needed) { try { needed = await d.apsMapping.needed(); } catch { needed = false; } }
    if (!needed) { aps = { status: 'covered' }; return; }
    log('shipstation: APS line-item export');
    aps = await guarded(() => d.apsMapping.run({ scrText: scrText || null,
      scrSource: scrText && scrPayload ? { sanitizedSha256: scrPayload.sanitizedSha256, from: scrPayload.requestedFrom, to: scrPayload.requestedTo } : null }));
    log(`aps mapping: ${aps.status}`);
  };
  try {
    // Quota first: with the day's D1 budget used up, no browser opens and nothing is exported or computed.
    // The work is not done; the next start after the reset (00:00 UTC = 07:00 ICT) resumes it.
    if (d.budget) {
      let b = null;
      try { b = await d.budget(); } catch { b = null; }
      if (b?.state === 'defer') {
        log(`deferred: daily D1 budget used (${(b.reasons || []).join(', ') || 'quota'}); resumes after ${b.resetAt || '00:00 UTC'}`);
        return { status: 'deferred', exitCode: EXIT.DEFERRED, sources: {}, resumeAfter: b.resetAt || null, reasons: b.reasons || [] };
      }
      // Fail closed: usage that cannot be measured never counts as "within budget". Nothing is exported or
      // computed; the run is partial, so the task's bounded retries (and the next trigger) try again.
      if (!b || b.state !== 'ok') {
        log('budget unavailable: no background work started');
        return { status: 'partial', exitCode: EXIT.PARTIAL, sources: {}, code: 'budget_unavailable' };
      }
    }
    let plan = null;
    try { plan = await d.weekPlan(); } catch { plan = null; }
    const workerSays = k => plan?.collected?.[k];
    // A source counts as collected only when the WORKER has it; the local record is a fallback when the Worker is unreachable.
    const nowMs = d.now ? d.now() : Date.now();
    // A refresh held for review: re-read the saved version's dates (never re-uploaded while they wait). Accepted →
    // done; a person rejected them → 'rejected', so the refresh below is due again and a fresh report is exported.
    if (await recheckAwaiting(mine, d, nowMs, m => log(`shipstation: ${m}`))) {
      state[d.week.weekStart] = { ...mine };
      saveState(d.stateFile, state, d.fs);
    }
    const refreshTo = d.midweek ? midweekReportDue({ week: d.week, entry: mine, now: nowMs, timeZone: d.midweek.timeZone, threshold: d.midweek.threshold,
                                                          published: plan?.draftStatus === 'published' }) : null;
    if (refreshTo) log(`shipstation: mid-week report refresh due (ship dates through ${refreshTo})`);
    const needReport = (plan ? workerSays('shipping_cost_report') !== 'ok' : mine.shipping_cost_report !== 'ok') || !!refreshTo;
    const needShopify = plan ? (workerSays('shopify') !== 'ok' || workerSays('shopify_updates') !== 'ok') : mine.shopify !== 'ok';
    if (!needReport && !needShopify) {
      await apsStep(null);
      const withAps = r => (aps ? { ...r, aps } : r);
      // Free-tier path: the sources being in does not mean the weeks are computed (e.g. a report
      // review was accepted after the last run, or a run stopped mid-compute). Computing is
      // idempotent: unchanged weeks are skipped and write nothing.
      if (!d.compute) return withAps({ status: 'already_collected', exitCode: EXIT.OK, sources: { shipping_cost_report: 'ok', shopify: 'ok' } });
      let compute;
      try { compute = await d.compute({ sources: { shipping_cost_report: 'ok', shopify: 'ok' } }); }
      catch (e) { compute = { status: 'failed', code: typeof e?.code === 'string' ? e.code.slice(0, 64) : 'compute_failed' }; }
      log(`compute: ${compute.status}`);
      rememberCoverage(compute);
      if (compute.status === 'deferred') return withAps({ status: 'deferred', exitCode: EXIT.DEFERRED, sources: { shipping_cost_report: 'ok', shopify: 'ok' }, compute, resumeAfter: compute.resumeAfter || null });
      return withAps({ status: compute.status === 'ok' ? 'already_collected' : 'partial', exitCode: compute.status === 'ok' ? EXIT.OK : EXIT.PARTIAL,
               sources: { shipping_cost_report: 'ok', shopify: 'ok' }, compute });
    }

    // 1. ShipStation (browser A), upload deferred
    let pending = null;
    if (needReport) {
      log('shipstation: collecting');
      const r = await guarded(() => d.shipstation.collect(refreshTo ? { reportTo: refreshTo } : {}));
      if (r.status === 'prepared' && r.pending) pending = r.pending;
      else sources.shipping_cost_report = r.status === 'ok' ? 'ok' : `${r.status} (exit ${r.exitCode})`;
    } else sources.shipping_cost_report = 'ok';
    // APS mapping right after the report, still before Shopify's browser (one browser at a time).
    await apsStep(pending?.prep?.sanitizedText || null, pending?.prep?.payload || null);
    let uploadedReport = null;                                          // the Worker's answer for the uploaded report
    const uploadShipStation = async () => {
      if (!pending) return 'nothing_pending';
      const p = pending; pending = null;
      const u = await guarded(() => d.shipstation.upload(p));
      sources.shipping_cost_report = u.status === 'ok' ? 'ok' : `${u.status} (exit ${u.exitCode})`;
      if (u.status === 'ok') uploadedReport = u.report || null;
      return `shipstation ${u.status}`;
    };

    // 2–4. Shopify (browser B); the ShipStation upload happens during the email wait, or before a wait
    // for a person to finish Shopify's sign-in (so that progress is kept whatever happens next).
    let uploadedNow = !!pending, signInNeeded = false;
    const signInEvent = async (status, detail) => { if (d.signInEvent) { try { await d.signInEvent(status, detail); } catch { /* status only */ } } };
    if (needShopify) {
      log('shopify: requesting export');
      const onSignInRequired = async ({ state, waitMinutes }) => {
        log(`shopify: sign-in needs a person (${state === 'captcha' ? 'human check' : 'two-step code'}); waiting up to ${waitMinutes} min in the open Shopify window, then continuing`);
        await uploadShipStation();
        await signInEvent('needs_person', { authState: state, waitMinutes });
      };
      const onSignedIn = async () => { log('shopify: signed in; continuing the export'); await signInEvent('signed_in'); };
      const m = await guarded(() => d.shopify.run({ onWaiting: uploadShipStation, onSignInRequired, onSignedIn }));
      sources.shopify = m.status === 'ok' ? 'ok' : `${m.status} (exit ${m.exitCode})`;
      signInNeeded = SIGNIN_STATUSES.has(m.status);
      if (signInNeeded) log('shopify: still waiting for a person to sign in; the next attempt opens the window again');
    } else sources.shopify = 'ok';
    if (pending) await uploadShipStation();                               // direct download or Shopify skipped

    const midweekReport = refreshTo && sources.shipping_cost_report === 'ok' ? await midweekOutcome(refreshTo, uploadedReport, d, log) : null;
    state[d.week.weekStart] = { ...mine, ...Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, v === 'ok' ? 'ok' : (mine[k] === 'ok' ? 'ok' : v)])),
                                ...(midweekReport ? { midweekReport } : {}),
                                lastRunAt: new Date(nowMs).toISOString() };
    saveState(d.stateFile, state, d.fs);
    const allOk = Object.values(sources).every(v => v === 'ok');
    // 6. Free-tier path (optional): compute the week and every changed week on this PC, upload the
    //    results and request independent verification. Codes and counts only.
    let compute;
    // While Shopify waits for a person, a retry that brought nothing new skips the compute (the previous
    // attempt computed what it could); it reads nothing more from D1 until the export arrives.
    if (d.compute && signInNeeded && !uploadedNow) compute = { status: 'skipped', code: 'shopify_signin_required' };
    else if (d.compute) {
      try { compute = await d.compute({ sources }); }
      catch (e) { compute = { status: 'failed', code: typeof e?.code === 'string' ? e.code.slice(0, 64) : 'compute_failed' }; }
      log(`compute: ${compute.status}`);
      rememberCoverage(compute);
    }
    const computeOk = !compute || compute.status === 'ok';
    // Deferral wins: retrying soon would only add load. Sources already received are kept (state above).
    if (compute?.status === 'deferred') return { status: 'deferred', exitCode: EXIT.DEFERRED, sources, compute, resumeAfter: compute.resumeAfter || null, ...(aps ? { aps } : {}) };
    const exitCode = allOk && computeOk ? EXIT.OK : signInNeeded ? EXIT.SIGNIN_REQUIRED : EXIT.PARTIAL;
    return { status: exitCode === EXIT.OK ? 'ok' : signInNeeded ? 'signin_required' : 'partial', exitCode, sources, ...(compute ? { compute } : {}), ...(aps ? { aps } : {}) };
  } finally {
    await lock.release(runLock, lockOpts);
  }
}
