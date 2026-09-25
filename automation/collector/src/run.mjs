#!/usr/bin/env node
/**
 * run.mjs — Windows entry point for the weekly collector orchestrator (C7)
 *   node src/run.mjs --config config.local.json [--week 2026-09-14] [--headed]
 * Task Scheduler: weekly Monday 15:05 (ICT) AND at startup/logon, with
 * "Run task as soon as possible after a scheduled start is missed".
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lastCompletedWeek, weekFromStart, assertSafeLocalDir, assertNoSecretsInConfig } from '../../shipstation-export/src/lib.mjs';
import { readWindowsCredential } from '../../shipstation-export/src/credentials.mjs';
import { workerEndpoint } from '../../shipstation-export/src/upload.mjs';
import { runShipStationJob, finishShipStationUpload } from '../../shipstation-export/src/export.mjs';
import { runShopifyJob } from '../../shopify-export/src/export.mjs';
import { weekWindowUtc } from '../../../shared/schedule.js';
import { runWeeklyCollection } from './orchestrate.mjs';

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
const closed = Date.now() >= Date.parse(weekWindowUtc(weekStart, tz).endUtcExclusive);

const r = await runWeeklyCollection({
  week: { ...w, closed },
  lockFile: path.join(base, 'collector.lock'), stateFile: path.join(base, 'state.json'),
  log: m => console.log(m),
  weekPlan: async () => {
    const { password } = readWindowsCredential(config.ingestCredentialTarget || 'sb-gp-ingest');
    const url = workerEndpoint(config.workerUrl, '/v1/ingest/week-plan');
    const res = await fetch(`${url}?at=${encodeURIComponent(new Date().toISOString())}`, { headers: { 'X-Ingest-Secret': password } });
    if (!res.ok) return null;
    const j = await res.json();
    return j.weekStart === weekStart ? j : null;                       // a different week (e.g. --week) → local record decides
  },
  shipstation: {
    collect: () => runShipStationJob({ config: ssConfig, week: w, headed: !!args.headed, deferUpload: true }),
    upload: pending => finishShipStationUpload(pending),
  },
  shopify: { run: ({ onWaiting }) => runShopifyJob({ config: shConfig, week: w, headed: !!args.headed, onWaiting }) },
});
console.log(`${r.status} (exit ${r.exitCode}) ${JSON.stringify(r.sources)}`);
process.exitCode = r.exitCode;
