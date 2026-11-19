#!/usr/bin/env node
/**
 * purge.mjs — daily cleanup (Task Scheduler), independent of the weekly export
 *   node src/purge.mjs --config config.local.json
 * Deletes quarantined sanitized files and any leftover download older than 72 hours.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { purgeOlderThan, assertNoSecretsInConfig } from '../../shipstation-export/src/lib.mjs';
import { localPaths, RETENTION_MS } from './lib.mjs';

export function runPurge(config, now = Date.now()) {
  assertNoSecretsInConfig(config);
  const paths = localPaths(config);
  return { quarantineRemoved: purgeOlderThan(paths.quarantine, RETENTION_MS, now), downloadsRemoved: purgeOlderThan(paths.downloads, RETENTION_MS, now) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf('--config');
  const config = JSON.parse(fs.readFileSync(i > 0 ? process.argv[i + 1] : 'config.local.json', 'utf8'));
  const r = runPurge(config);
  console.log(`purged ${r.quarantineRemoved} quarantined and ${r.downloadsRemoved} downloaded file(s) older than 72h`);
}
