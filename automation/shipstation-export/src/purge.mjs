#!/usr/bin/env node
/**
 * purge.mjs — daily quarantine cleanup (Windows Task Scheduler, independent of the weekly export)
 * ================================================================================================
 *   node src/purge.mjs --config config.local.json
 *
 * Deletes quarantined and leftover downloaded files older than 72 hours, so the
 * retention limit holds even in weeks when no export runs. Prints counts only,
 * never file contents.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { localPaths, purgeOlderThan, assertNoSecretsInConfig } from './lib.mjs';

export const RETENTION_MS = 72 * 3600_000;

export function runPurge(config, now = Date.now()) {
  assertNoSecretsInConfig(config);
  const paths = localPaths(config);
  return {
    quarantineRemoved: purgeOlderThan(paths.quarantine, RETENTION_MS, now),
    downloadsRemoved: purgeOlderThan(paths.downloads, RETENTION_MS, now),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf('--config');
  const config = JSON.parse(fs.readFileSync(i > 0 ? process.argv[i + 1] : 'config.local.json', 'utf8'));
  const r = runPurge(config);
  console.log(`purged ${r.quarantineRemoved} quarantined and ${r.downloadsRemoved} downloaded file(s) older than 72h`);
}
