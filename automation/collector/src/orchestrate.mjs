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
export const EXIT = Object.freeze({ OK: 0, ALREADY_RUNNING: 5, NOT_DUE: 0, PARTIAL: 40 });

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
 * @param {{ run: ({ onWaiting }) => Promise<{status, exitCode}> }} d.shopify
 * @param {string} d.lockFile
 * @param {string} d.stateFile
 */
export async function runWeeklyCollection(d) {
  const log = d.log || (() => {});
  if (!d.week.closed) return { status: 'week_not_closed', exitCode: EXIT.NOT_DUE, sources: {} };
  if (!acquireLock(d.lockFile, { now: d.now ? d.now() : Date.now(), fsImpl: d.fs })) return { status: 'already_running', exitCode: EXIT.ALREADY_RUNNING, sources: {} };
  const state = loadState(d.stateFile, d.fs);
  const mine = state[d.week.weekStart] || {};
  const sources = {};
  try {
    let plan = null;
    try { plan = await d.weekPlan(); } catch { plan = null; }
    const workerSays = k => plan?.collected?.[k];
    // A source counts as collected only when the WORKER has it; the local record is a fallback when the Worker is unreachable.
    const needReport = plan ? workerSays('shipping_cost_report') !== 'ok' : mine.shipping_cost_report !== 'ok';
    const needShopify = plan ? (workerSays('shopify') !== 'ok' || workerSays('shopify_updates') !== 'ok') : mine.shopify !== 'ok';
    if (!needReport && !needShopify) return { status: 'already_collected', exitCode: EXIT.OK, sources: { shipping_cost_report: 'ok', shopify: 'ok' } };

    // 1. ShipStation (browser A), upload deferred
    let pending = null;
    if (needReport) {
      log('shipstation: collecting');
      const r = await d.shipstation.collect();
      if (r.status === 'prepared' && r.pending) pending = r.pending;
      else sources.shipping_cost_report = r.status === 'ok' ? 'ok' : `${r.status} (exit ${r.exitCode})`;
    } else sources.shipping_cost_report = 'ok';
    const uploadShipStation = async () => {
      if (!pending) return 'nothing_pending';
      const p = pending; pending = null;
      const u = await d.shipstation.upload(p);
      sources.shipping_cost_report = u.status === 'ok' ? 'ok' : `${u.status} (exit ${u.exitCode})`;
      return `shipstation ${u.status}`;
    };

    // 2–4. Shopify (browser B); the ShipStation upload happens during the email wait
    if (needShopify) {
      log('shopify: requesting export');
      const m = await d.shopify.run({ onWaiting: uploadShipStation });
      sources.shopify = m.status === 'ok' ? 'ok' : `${m.status} (exit ${m.exitCode})`;
    } else sources.shopify = 'ok';
    if (pending) await uploadShipStation();                               // direct download or Shopify skipped

    state[d.week.weekStart] = { ...mine, ...Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, v === 'ok' ? 'ok' : (mine[k] === 'ok' ? 'ok' : v)])),
                                lastRunAt: new Date(d.now ? d.now() : Date.now()).toISOString() };
    saveState(d.stateFile, state, d.fs);
    const allOk = Object.values(sources).every(v => v === 'ok');
    return { status: allOk ? 'ok' : 'partial', exitCode: allOk ? EXIT.OK : EXIT.PARTIAL, sources };
  } finally {
    releaseLock(d.lockFile, d.fs);
  }
}
