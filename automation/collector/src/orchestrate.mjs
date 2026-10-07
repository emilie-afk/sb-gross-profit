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
 * a repeat run never re-exports what already arrived. A lock file keeps two
 * instances from overlapping.
 *
 * Pure orchestration: every side effect is injected (run.mjs wires the real ones).
 */
import fs from 'node:fs';
import path from 'node:path';

export const LOCK_STALE_MS = 3 * 3600_000;
/** SIGNIN_REQUIRED: everything else is done or partial, and Shopify still waits for a person to sign in (the task retries sooner). */
/** DEFERRED: the day's D1 budget is used up; nothing more is attempted until after 00:00 UTC (never "done"). */
export const EXIT = Object.freeze({ OK: 0, ALREADY_RUNNING: 5, NOT_DUE: 0, PARTIAL: 40, SIGNIN_REQUIRED: 41, DEFERRED: 42 });
/** Shopify outcomes that only a person can resolve (two-step code, human check). */
const SIGNIN_STATUSES = new Set(['needs_2fa', 'needs_human_captcha']);

/** Exclusive lock file; a lock older than LOCK_STALE_MS (crashed run) is replaced. */
export function acquireLock(file, { now = Date.now(), fsImpl = fs } = {}) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fsImpl.openSync(file, 'wx');
      fsImpl.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() }));
      fsImpl.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let stale = false;
      try { stale = now - fsImpl.statSync(file).mtimeMs > LOCK_STALE_MS; } catch { stale = true; }
      if (!stale) return false;
      try { fsImpl.rmSync(file, { force: true }); } catch { /* raced; retry once */ }
    }
  }
  return false;
}
export const releaseLock = (file, fsImpl = fs) => { try { fsImpl.rmSync(file, { force: true }); } catch { /* ignore */ } };

/** Local record of what this PC delivered per week (sources and statuses only). */
export function loadState(file, fsImpl = fs) { try { return JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch { return {}; } }
export function saveState(file, state, fsImpl = fs) { fsImpl.mkdirSync(path.dirname(file), { recursive: true }); fsImpl.writeFileSync(file, JSON.stringify(state, null, 2)); }

/**
 * @param {object} d
 * @param {{ weekStart, weekEnd, closed: boolean }} d.week          the last closed reporting week
 * @param {() => Promise<{ collected: object }|null>} d.weekPlan    Worker week plan (null when unreachable)
 * @param {{ collect: () => Promise<{status, exitCode, pending?}>, upload: (pending) => Promise<{status, exitCode}> }} d.shipstation
 * @param {{ run: ({ onWaiting, onSignInRequired, onSignedIn }) => Promise<{status, exitCode}> }} d.shopify
 * @param {(status: 'needs_person'|'signed_in', detail?: object) => Promise<void>} [d.signInEvent]  tells the Worker (shown on the status)
 * @param {() => Promise<{ state: 'ok'|'defer'|'unknown', resetAt?, reasons? }>} [d.budget]  the day's D1 budget (Free-tier path)
 * @param {{ needed: () => Promise<boolean>, run: ({ scrText }) => Promise<{ status, exitCode?, facts? }> }} [d.apsMapping]
 *        Air Plant Shop scenario input (the saved line-item export, mapping only). Runs after the Shipping Cost
 *        Report (its rows let split shipments be matched) or, when that is already in, only if the stored mapping
 *        does not cover the week. Its outcome never changes the run's exit code: a failed export is retried by
 *        the next run (its window starts where the stored mapping ends).
 * @param {string} d.lockFile
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

export async function runWeeklyCollection(d) {
  const log = d.log || (() => {});
  if (!d.week.closed) return { status: 'week_not_closed', exitCode: EXIT.NOT_DUE, sources: {} };
  if (!acquireLock(d.lockFile, { now: d.now ? d.now() : Date.now(), fsImpl: d.fs })) return { status: 'already_running', exitCode: EXIT.ALREADY_RUNNING, sources: {} };
  const state = loadState(d.stateFile, d.fs);
  const mine = state[d.week.weekStart] || {};
  const sources = {};
  let aps;                                                             // { status, ... } when the APS mapping step ran
  const apsStep = async (scrText, scrPayload = null) => {
    if (!d.apsMapping) return;
    let needed = !!scrText;
    if (!needed) { try { needed = await d.apsMapping.needed(); } catch { needed = false; } }
    if (!needed) { aps = { status: 'covered' }; return; }
    log('shipstation: Air Plant Shop line-item export');
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
    const needReport = plan ? workerSays('shipping_cost_report') !== 'ok' : mine.shipping_cost_report !== 'ok';
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
      if (compute.status === 'deferred') return withAps({ status: 'deferred', exitCode: EXIT.DEFERRED, sources: { shipping_cost_report: 'ok', shopify: 'ok' }, compute, resumeAfter: compute.resumeAfter || null });
      return withAps({ status: compute.status === 'ok' ? 'already_collected' : 'partial', exitCode: compute.status === 'ok' ? EXIT.OK : EXIT.PARTIAL,
               sources: { shipping_cost_report: 'ok', shopify: 'ok' }, compute });
    }

    // 1. ShipStation (browser A), upload deferred
    let pending = null;
    if (needReport) {
      log('shipstation: collecting');
      const r = await guarded(() => d.shipstation.collect());
      if (r.status === 'prepared' && r.pending) pending = r.pending;
      else sources.shipping_cost_report = r.status === 'ok' ? 'ok' : `${r.status} (exit ${r.exitCode})`;
    } else sources.shipping_cost_report = 'ok';
    // Air Plant Shop mapping right after the report, still before Shopify's browser (one browser at a time).
    await apsStep(pending?.prep?.sanitizedText || null, pending?.prep?.payload || null);
    const uploadShipStation = async () => {
      if (!pending) return 'nothing_pending';
      const p = pending; pending = null;
      const u = await guarded(() => d.shipstation.upload(p));
      sources.shipping_cost_report = u.status === 'ok' ? 'ok' : `${u.status} (exit ${u.exitCode})`;
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

    state[d.week.weekStart] = { ...mine, ...Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, v === 'ok' ? 'ok' : (mine[k] === 'ok' ? 'ok' : v)])),
                                lastRunAt: new Date(d.now ? d.now() : Date.now()).toISOString() };
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
    }
    const computeOk = !compute || compute.status === 'ok';
    // Deferral wins: retrying soon would only add load. Sources already received are kept (state above).
    if (compute?.status === 'deferred') return { status: 'deferred', exitCode: EXIT.DEFERRED, sources, compute, resumeAfter: compute.resumeAfter || null, ...(aps ? { aps } : {}) };
    const exitCode = allOk && computeOk ? EXIT.OK : signInNeeded ? EXIT.SIGNIN_REQUIRED : EXIT.PARTIAL;
    return { status: exitCode === EXIT.OK ? 'ok' : signInNeeded ? 'signin_required' : 'partial', exitCode, sources, ...(compute ? { compute } : {}), ...(aps ? { aps } : {}) };
  } finally {
    releaseLock(d.lockFile, d.fs);
  }
}
