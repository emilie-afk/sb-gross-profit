#!/usr/bin/env node
/**
 * run.mjs — Windows entry point for the weekly collector orchestrator (C7)
 *   node src/run.mjs --config config.local.json [--week 2026-09-14] [--headed] [--recovery]
 * Task Scheduler: weekly Monday 15:05 (ICT) AND at startup/logon, with
 * "Run task as soon as possible after a scheduled start is missed".
 */
import { scrub } from '../../shipstation-export/src/redact.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lastCompletedWeek, weekFromStart, assertSafeLocalDir, assertNoSecretsInConfig } from '../../shipstation-export/src/lib.mjs';
import { readWindowsCredential } from '../../shipstation-export/src/credentials.mjs';
import { workerEndpoint } from '../../shipstation-export/src/upload.mjs';
import { runShipStationJob, finishShipStationUpload } from '../../shipstation-export/src/export.mjs';
import { apsExportWindow, assertKindEnabled, PUBLICATION_EARLIEST_DATE } from '../../shipstation-export/src/kinds.mjs';
import { parseCSV } from '../../../shared/calculator.js';
import { runShopifyJob } from '../../shopify-export/src/export.mjs';
import { weekWindowUtc } from '../../../shared/schedule.js';
import { runWeeklyCollection } from './orchestrate.mjs';
import { freeTierPipeline } from './freeTier.mjs';

const args = (() => { const a = process.argv.slice(2), o = {}; for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) o[a[i].slice(2)] = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true; return o; })();
const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(args.config || 'config.local.json', 'utf8'));
assertNoSecretsInConfig(config);
const readJson = p => JSON.parse(fs.readFileSync(path.resolve(here, '..', p), 'utf8'));
const ssConfig = readJson(config.shipstationConfig || '../shipstation-export/config.local.json');
const shConfig = readJson(config.shopifyConfig || '../shopify-export/config.local.json');
if (ssConfig.localDir && shConfig.localDir && path.resolve(ssConfig.localDir) === path.resolve(shConfig.localDir)) throw new Error('ShipStation and Shopify need separate local folders (separate browser profiles)');
const base = assertSafeLocalDir(config.localDir || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'sb-collector'));
const tz = config.timeZone || 'America/Los_Angeles';
const weekStart = args.week || lastCompletedWeek(new Date(), tz).weekStart;
const w = weekFromStart(weekStart);
const closeAt = Date.parse(weekWindowUtc(weekStart, tz).endUtcExclusive);
// Free-tier path: Task Scheduler may start this before the week closes (Monday 14:05 ICT covers
// both Pacific offsets); wait for the close when it is near, so the verified draft can be ready by 15:30 ICT.
const waitMs = closeAt - Date.now();
if (config.pipeline === 'free_tier' && !args.week && waitMs > 0 && waitMs <= (config.waitForCloseMinutes ?? 75) * 60_000) {
  console.log(`waiting ${Math.ceil(waitMs / 60_000)} min for the reporting week to close`);
  await new Promise(r => setTimeout(r, waitMs + 60_000));
}
const closed = Date.now() >= closeAt;

// Pipeline: 'free_tier' (the office PC computes; the Worker validates and stores) or the csv_text routes.
const ingestSecret = () => readWindowsCredential(config.ingestCredentialTarget || 'sb-gp-ingest').password;
const ft = config.pipeline === 'free_tier' ? freeTierPipeline({
  workerUrl: config.workerUrl, ingestSecret: ingestSecret(), closedWeek: weekStart,
  verifyUrl: config.verifyUrl || null, verifyWaitMs: (config.verifyWaitMinutes ?? 8) * 60_000, maxRefreshesPerRun: config.maxRefreshesPerRun ?? 12,
  triggerSecret: config.verifyUrl ? readWindowsCredential(config.verifyTriggerCredentialTarget || 'sb-gp-verify-trigger').password : null,
}) : null;

// Recovery start (the task's daily and repeat triggers once the week is marked done on this PC): one cheap
// question to the Worker first. Nothing unfinished → exit now (no browser, no compute). No budget → exit 42.
// The check itself failing → exit 40 (bounded retries); it never counts as "nothing to do" or "within budget".
if (args.recovery && ft) {
  let w = null;
  try { w = await ft.work(); } catch { w = null; }
  if (!w) { console.log('recovery: unfinished-work check unavailable (exit 40)'); process.exit(40); }
  if (!w.unfinished?.length) { console.log('recovery: nothing unfinished (exit 0)'); process.exit(0); }
  if (w.budget?.state !== 'ok') { console.log(`recovery: ${w.unfinished.join(', ')}; deferred (${(w.budget?.reasons || []).join(', ')})`); process.exit(w.budget?.state === 'defer' ? 42 : 40); }
  console.log(`recovery: resuming ${w.unfinished.join(', ')}`);
}

const r = await runWeeklyCollection({
  week: { ...w, closed },
  lockFile: path.join(base, 'collector.lock'), stateFile: path.join(base, 'state.json'),
  log: m => console.log(scrub(m)),
  weekPlan: ft ? () => ft.weekPlan() : async () => {
    const { password } = readWindowsCredential(config.ingestCredentialTarget || 'sb-gp-ingest');
    const url = workerEndpoint(config.workerUrl, '/v1/ingest/week-plan');
    const res = await fetch(`${url}?at=${encodeURIComponent(new Date().toISOString())}`, { headers: { 'X-Ingest-Secret': password } });
    if (!res.ok) return null;
    const j = await res.json();
    return j.weekStart === weekStart ? j : null;                       // a different week (e.g. --week) → local record decides
  },
  shipstation: {
    collect: () => runShipStationJob({ config: ssConfig, week: w, headed: !!args.headed, deferUpload: true }),
    upload: pending => finishShipStationUpload(pending, ft ? { uploadImpl: ft.uploadImpl } : {}),
  },
  // Air Plant Shop scenario input (free-tier path): the saved line-item export, mapping only. Not configured or
  // turned off → reported, never a failure of the week.
  ...(ft ? { apsMapping: {
    needed: async () => { const cov = await ft.apsCoverage(); return !cov || !cov.coveredTo || cov.coveredTo < w.weekEnd || !cov.coveredFrom || cov.coveredFrom > PUBLICATION_EARLIEST_DATE; },
    run: async ({ scrText, scrSource }) => {
      try { assertKindEnabled('shipstation_aps_mapping', ssConfig); } catch (e) { return { status: e.code || 'aps_mapping_off' }; }
      const apsWindow = apsExportWindow(w, await ft.apsCoverage());
      const job = await runShipStationJob({ config: ssConfig, week: w, kind: 'shipstation_aps_mapping', headed: !!args.headed, deferUpload: true,
        apsWindow, scrRows: scrText ? parseCSV(scrText) : null, scrSource: scrText ? scrSource : null, resolveScrRows: pairs => ft.scrRowsFor(pairs) });
      if (job.status !== 'prepared') return { status: job.status, exitCode: job.exitCode };
      const up = await finishShipStationUpload(job.pending, { uploadImpl: ft.uploadImpl });
      const m = up.manifest || {};
      return { status: up.status, window: `${apsWindow.from}..${apsWindow.to}`, exportMs: m.exportMs ?? null, apsOrders: m.apsOrders ?? null,
               byStatus: m.byStatus || null, sourceStatus: m.ingest?.sourceStatus || null };
    },
  } } : {}),
  shopify: { run: ({ onWaiting, onSignInRequired, onSignedIn }) => runShopifyJob({ config: shConfig, week: w, headed: !!args.headed, onWaiting, onSignInRequired, onSignedIn,
    ...(ft ? { uploadImpl: ft.uploadImpl } : {}) }) },
  ...(ft ? { compute: () => ft.compute(), signInEvent: (status, detail) => ft.signInEvent(status, detail), budget: () => ft.budget() } : {}),
});
console.log(scrub(`${r.status} (exit ${r.exitCode}) ${JSON.stringify(r.sources)}${r.compute ? ` compute ${JSON.stringify(r.compute)}` : ''}${r.aps ? ` aps ${JSON.stringify(r.aps)}` : ''}`));
process.exitCode = r.exitCode;
