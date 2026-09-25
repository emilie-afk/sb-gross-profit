#!/usr/bin/env node
/**
 * summary.mjs — aggregate-only summary of the collectors' run manifests (C8)
 * ==========================================================================
 *   node src/summary.mjs [--since 2026-09-21] [--json]
 *
 * For live acceptance reports: prints per run the kind, week, status, exit
 * code, timings, counts, hashes and host NAMES only. Every field is copied
 * from an allowlist, so nothing else a manifest might hold (an error text,
 * evidence, a file name, an ingest response) is ever printed. Never a row, an
 * email header or body, a download link, a path, a token or a secret.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HASH = /^[0-9a-f]{16,64}$/;
const HOST = /^[a-z0-9.-]{1,253}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CODE = /^[a-z_]{1,64}$/;
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const pick = (v, re) => (typeof v === 'string' && re.test(v) ? v : undefined);

/** One manifest → the allowlisted aggregate view. */
export function summarizeManifest(m) {
  if (!m || typeof m !== 'object') return null;
  // Shopify nests its facts; ShipStation writes them at the top level.
  const facts = { ...m, ...(m.facts && typeof m.facts === 'object' ? m.facts : {}) };
  const ingest = m.ingest && typeof m.ingest === 'object' ? m.ingest : {};
  const out = {
    kind: pick(m.kind, CODE), weekStart: pick(m.weekStart, DATE), windowFrom: pick(m.windowFrom, DATE), windowTo: pick(m.windowTo, DATE),
    status: pick(m.status, CODE), exitCode: num(m.exitCode), startedAt: pick(m.startedAt, ISO), finishedAt: pick(m.finishedAt, ISO),
    authStateAtStart: pick(m.authStateAtStart, CODE), mailboxVerified: m.mailboxVerified === true ? true : undefined,
    emailReceivedAt: pick(m.email?.receivedAt, ISO), emailPolls: num(m.email?.polls ?? m.polls), messageIdSha256: pick(m.email?.messageIdSha256, HASH),
    downloadHost: pick(m.downloadHost, HOST), downloadFinalHost: pick(m.downloadFinalHost, HOST),
    downloadVia: pick(m.download?.via, CODE), downloadBytes: num(m.download?.bytes), downloadFormat: pick(m.download?.format, CODE),
    requestedFrom: pick(facts.requestedFrom, DATE), requestedTo: pick(facts.requestedTo, DATE),
    orders: num(facts.orderCount), rows: num(facts.rowCount), rawSha256: pick(facts.rawSha256, HASH), sanitizedSha256: pick(facts.sanitizedSha256, HASH),
    shippingCostTotal: num(facts.shippingCostTotal), droppedColumns: facts.dropped && typeof facts.dropped === 'object' && !Array.isArray(facts.dropped) ? Object.keys(facts.dropped).length
      : (Array.isArray(facts.dropped) ? facts.dropped.length : undefined),
    reviewFlags: facts.reviewFlags && typeof facts.reviewFlags === 'object' ? Object.keys(facts.reviewFlags).filter(k => CODE.test(k)) : undefined,
    versionStatus: pick(ingest.status, CODE), ingestHttp: num(ingest.httpStatus), uploadAttempts: num(ingest.attempts), sourceStatus: pick(ingest.sourceStatus, CODE), sourceHash: pick(ingest.sourceHash, HASH), whileWaiting: typeof m.whileWaiting === 'string' ? (m.whileWaiting.startsWith('error') ? 'error' : pick(m.whileWaiting, CODE)) : undefined,
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

export function readManifests(dirs, { since = null } = {}) {
  const out = [];
  for (const d of dirs) {
    let files = []; try { files = fs.readdirSync(d).filter(f => f.endsWith('.json')); } catch { continue; }
    for (const f of files) {
      let m; try { m = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { continue; }
      const s = summarizeManifest(m);
      if (s && (!since || (s.startedAt || '') >= since)) out.push(s);
    }
  }
  return out.sort((a, b) => ((a.startedAt || '') < (b.startedAt || '') ? -1 : 1));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const a = process.argv.slice(2);
  const since = a.includes('--since') ? a[a.indexOf('--since') + 1] : null;
  const root = process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
  const rows = readManifests([path.join(root, 'sb-shipstation-export', 'runs'), path.join(root, 'sb-shopify-export', 'runs')], { since });
  if (a.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else for (const r of rows) console.log(Object.entries(r).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : v}`).join('  '));
}
