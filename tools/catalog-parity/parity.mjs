#!/usr/bin/env node
/**
 * parity.mjs — build.py vs the Worker's catalog builder, on the same source files
 * ==============================================================================
 *   node tools/catalog-parity/parity.mjs <sources.json> [--show-keys]
 *
 * <sources.json> maps build.py environment names to local files (and optionally
 * "productExport": { "name", "path" }). Real sheet exports must live OUTSIDE the
 * repository; this tool refuses paths inside it (synthetic test fixtures excepted
 * when --allow-fixtures is given by the test suite).
 *
 * It copies build.py / vendor_sheets.py / catalog_hook.py to a temporary
 * directory, runs them through run_build.py (no network, no push), builds the
 * same tables with shared/catalogBuild.js, and prints aggregates: per-table
 * entry counts, whether each table is identical, and both catalog revisions.
 * --show-keys also prints up to 10 differing keys per table, for local
 * debugging only; never paste that output into a report or commit it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildCatalogTables, URL_SOURCES, JSON_SOURCES } from '../../shared/catalogBuild.js';
import { catalogRevOf, parseMcgExtraCsv, CATALOG_TABLES } from '../../shared/catalog.js';
import { stableStringify } from '../../shared/normalized.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const FIXTURES = path.join(REPO, 'tests', 'fixtures');

function checkPath(p, allowFixtures) {
  const abs = path.resolve(p);
  const rel = path.relative(REPO, abs);
  const inside = !rel.startsWith('..') && !path.isAbsolute(rel);
  if (inside && !(allowFixtures && !path.relative(FIXTURES, abs).startsWith('..'))) throw new Error('Refusing a source file inside the repository');
  if (!fs.statSync(abs).isFile()) throw new Error('Expected a file');
  return abs;
}

const decode = (buf, mode) => (mode === 'replace' ? new TextDecoder('utf-8', { ignoreBOM: true }).decode(buf) : new TextDecoder('utf-8', { fatal: true }).decode(buf));

export async function runParity(sourcesFile, { allowFixtures = false, showKeys = false, python = 'python3' } = {}) {
  const spec = JSON.parse(fs.readFileSync(sourcesFile, 'utf8'));
  const base = path.dirname(path.resolve(sourcesFile));
  const resolved = {};
  for (const [k, v] of Object.entries(spec)) {
    if (k === 'productExport') resolved[k] = { name: v.name, path: checkPath(path.resolve(base, v.path), allowFixtures) };
    else if ([...URL_SOURCES, ...JSON_SOURCES].includes(k)) resolved[k] = checkPath(path.resolve(base, v), allowFixtures);
    else throw new Error(`Unknown source name ${k}`);
  }

  // Python side
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-parity-'));
  try {
    for (const f of ['build.py', 'vendor_sheets.py', 'catalog_hook.py']) fs.copyFileSync(path.join(REPO, f), path.join(work, f));
    const srcJson = path.join(work, 'sources.json');
    fs.writeFileSync(srcJson, JSON.stringify(resolved));
    execFileSync(python, [path.join(HERE, 'run_build.py'), work, srcJson], { stdio: ['ignore', 'pipe', 'pipe'] });
    const data = path.join(work, 'data');
    const pyTables = {};
    for (const name of CATALOG_TABLES) {
      const f = path.join(data, `${name}.json`);
      if (fs.existsSync(f)) pyTables[name] = JSON.parse(fs.readFileSync(f, 'utf8'));
    }
    const extraFile = path.join(data, 'mcg_extra.csv.txt');
    const pyCandidate = { tables: pyTables, mcgExtra: fs.existsSync(extraFile) ? parseMcgExtraCsv(fs.readFileSync(extraFile, 'utf8')) : {}, overrides: {} };

    // Worker side, from the same bytes and the Worker's decoding
    const texts = {};
    for (const k of URL_SOURCES) if (resolved[k]) texts[k] = decode(fs.readFileSync(resolved[k]), k === 'MCG_EXTRA_SHEET_URL' ? 'replace' : 'sig');
    for (const k of JSON_SOURCES) if (resolved[k]) texts[k] = fs.readFileSync(resolved[k], 'utf8');
    if (resolved.productExport) texts.productExport = { name: resolved.productExport.name, text: decode(fs.readFileSync(resolved.productExport.path), 'sig') };
    const js = buildCatalogTables(texts);
    const jsCandidate = { tables: js.tables, mcgExtra: js.mcgExtra, overrides: {} };

    const names = [...new Set([...Object.keys(pyTables), ...Object.keys(js.tables), 'mcgExtra'])].sort();
    const tables = {};
    for (const n of names) {
      const a = n === 'mcgExtra' ? pyCandidate.mcgExtra : pyTables[n], b = n === 'mcgExtra' ? jsCandidate.mcgExtra : js.tables[n];
      const row = { buildPy: a === undefined ? null : Object.keys(a).length, worker: b === undefined ? null : Object.keys(b).length,
                    identical: a !== undefined && b !== undefined && stableStringify(a) === stableStringify(b) };
      if (!row.identical && a && b) {
        const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
        const diff = keys.filter(k => stableStringify(a[k]) !== stableStringify(b[k]));
        row.differingKeys = diff.length;
        if (showKeys) row.sample = diff.slice(0, 10);
      }
      tables[n] = row;
    }
    const pyRev = await catalogRevOf(pyCandidate), jsRev = await catalogRevOf(jsCandidate);
    return { identical: pyRev === jsRev && Object.values(tables).every(t => t.identical || (t.buildPy === null && t.worker === null)),
             buildPyCatalogRev: pyRev, workerCatalogRev: jsRev, tables, jsCandidate };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const a = process.argv.slice(2);
  if (!a[0]) { console.error('usage: parity.mjs <sources.json> [--show-keys]'); process.exit(2); }
  const r = await runParity(a[0], { showKeys: a.includes('--show-keys'), allowFixtures: a.includes('--allow-fixtures') });
  const { jsCandidate: _omit, ...out } = r;
  console.log(JSON.stringify(out, null, 2));
  process.exit(r.identical ? 0 : 1);
}
