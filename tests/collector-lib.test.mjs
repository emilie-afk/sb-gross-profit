/**
 * Collector infrastructure (C1): delivery default, local-folder safety, daily
 * purge, exact mapping-export template. Temporary folders only; no real data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDelivery, assertSafeLocalDir, MAPPING_EXPORT_COLUMNS, unexpectedColumns } from '../automation/shipstation-export/src/lib.mjs';
import { runPurge, RETENTION_MS } from '../automation/shipstation-export/src/purge.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Worker delivery is the default; Drive rollback needs delivery "drive" AND an explicit outputDir', () => {
  assert.equal(resolveDelivery({}).delivery, 'worker');
  assert.equal(resolveDelivery({ delivery: null, outputDir: 'D:/somewhere' }).delivery, 'worker');   // outputDir alone does nothing
  assert.throws(() => resolveDelivery({ delivery: 'drive' }), /outputDir/);
  assert.deepEqual(resolveDelivery({ delivery: 'drive', outputDir: 'D:/rollback' }), { delivery: 'drive', outputDir: 'D:/rollback' });
  assert.throws(() => resolveDelivery({ delivery: 'email' }), /"worker" or "drive"/);
});

test('the example config delivers to the Worker', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'automation/shipstation-export/config.example.json'), 'utf8'));
  assert.equal(resolveDelivery(cfg).delivery, 'worker');
});

test('local working folders inside the repository or a cloud-synced folder are refused', () => {
  assert.throws(() => assertSafeLocalDir(path.join(REPO, 'tmp-exports')), /outside the repository/);
  for (const p of ['C:/Users/x/OneDrive - SB/exports', 'G:/My Drive/exports', '/home/x/Dropbox/exports', '/Users/x/Library/iCloud Drive/x'])
    assert.throws(() => assertSafeLocalDir(p), /cloud-synced/, p);
  assert.throws(() => assertSafeLocalDir('/data/od/work', { env: { OneDrive: '/data/od' } }), /OneDrive/);
  assert.doesNotThrow(() => assertSafeLocalDir(path.join(os.tmpdir(), 'sb-collector-test')));
});

test('the daily purge removes quarantined and leftover downloads older than 72h, without any export running', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-purge-'));
  const q = path.join(base, 'quarantine'), d = path.join(base, 'downloads');
  fs.mkdirSync(q); fs.mkdirSync(d);
  const now = Date.now();
  const put = (dir, name, ageMs) => { const f = path.join(dir, name); fs.writeFileSync(f, 'synthetic'); const t = (now - ageMs) / 1000; fs.utimesSync(f, t, t); };
  put(q, 'old.csv', RETENTION_MS + 60_000); put(q, 'new.csv', RETENTION_MS - 60_000); put(d, 'stale.csv', RETENTION_MS + 1);
  const r = runPurge({ localDir: base }, now);
  assert.deepEqual(r, { quarantineRemoved: 1, downloadsRemoved: 1 });
  assert.deepEqual(fs.readdirSync(q), ['new.csv']);
  assert.equal(RETENTION_MS, 72 * 3600_000);
  fs.rmSync(base, { recursive: true });
});

test('the mapping export must have exactly the saved template columns', () => {
  assert.deepEqual(unexpectedColumns(MAPPING_EXPORT_COLUMNS, MAPPING_EXPORT_COLUMNS), []);
  assert.deepEqual(unexpectedColumns([...MAPPING_EXPORT_COLUMNS, 'Created By', 'Ship To - Name', 'Buyer Notes'], MAPPING_EXPORT_COLUMNS),
    ['Created By', 'Ship To - Name', 'Buyer Notes']);
});
