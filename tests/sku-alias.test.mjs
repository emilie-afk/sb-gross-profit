/**
 * SKU alias sheets: the Products Master product tabs (explicit columns, several aliases per cell) and the older
 * two-column sheet. build.py and the Worker's builder read them identically (catalog-build.test.mjs runs the parity);
 * here: the exact map, the conflicts and invalid tokens that are reported and left out, the build log, and the effect
 * on cost lookup (an alias only fills a SKU that has no cost of its own). Synthetic sheets only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildCatalogTables } from '../shared/catalogBuild.js';
import { engineArgsFromCatalog } from '../shared/catalog.js';
import { resolveCost } from '../shared/calculator.js';
import { syntheticSheets } from './fixtures-catalog.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HAVE_PY = spawnSync('python3', ['--version']).status === 0;

const EXPECTED_ALIASES = {
  // SB products tab: canonical = SB Bundles SKU (else MCG SKU); one alias per line, spaces around trimmed.
  '9001-2-VAR': 'S2KY1111', '2INCOLOR-S2KY1111': 'S2KY1111',
  '9001-2P': 'S2KY1111+EEZZ7620.BR-1', 'E9001-2P': 'S2KY1111+EEZZ7620.BR-1',
  '9002-2': 'S2KY5555', '9011-2': 'S2KY9898',
  // HP products tab: canonical = HD SKU.
  '7001-4-PL': '4_HOYA_SYNTH', 'H7001-4-PL-BPF': '4_HOYA_SYNTH', '7003-6-PL': '6_POTHOS_SYNTH',
  // Older two-column sheet (SB_SKU_ALIAS_URL).
  'AMZ-1111': 'S2KY1111', 'AMZ-5555': 'S2KY5555',
};
const EXPECTED_CONFLICTS = [
  '4_FERN_SYNTH -> 6_FERN_SYNTH (also a product SKU)',     // HP product listed with no aliases of its own
  '7002-4-PL -> 4_POTHOS_SYNTH | 6_POTHOS_SYNTH',
  '9003-2 -> S2KY3333 | S2KY6666',
  'S2KY0001 -> S2KY0002 (also a product SKU)',             // two-column sheet: a product row with a blank alias
  'S2KY1111 -> S2KY4444 (also a product SKU)',
  'S2KY7777 -> S2KY8888 (also a product SKU)',             // product A has no aliases; B lists A's SKU
  'S2KY9999 -> S2KY9898 (also a product SKU)',             // product whose only alias is itself
];

test('alias sheets: explicit Products Master columns, several aliases per cell, conflicts and bad tokens left out', async () => {
  const r = await buildCatalogTables(syntheticSheets());
  const aliases = Object.fromEntries(Object.entries(r.tables.sku_alias).filter(([k, v]) => k !== v));
  assert.deepEqual(aliases, EXPECTED_ALIASES);
  assert.deepEqual(r.report.skuAlias.conflicts, EXPECTED_CONFLICTS);
  assert.deepEqual(r.report.skuAlias.invalid, ['SB_SKU_ALIAS_URL_2:BAD TOKEN'], 'a token with a space inside is reported, never split into two SKUs');
  assert.equal(r.report.skuAlias.mappings, Object.keys(EXPECTED_ALIASES).length);
  assert.deepEqual(Object.fromEntries(Object.entries(r.report.sources).filter(([k]) => /ALIAS/.test(k)).map(([k, v]) => [k, v.layout])),
    { SB_SKU_ALIAS_URL: 'two-column', SB_SKU_ALIAS_URL_2: 'SB products', HP_SKU_ALIAS_URL: 'HP products' });
  for (const a of ['9003-2', '7002-4-PL', '9009-2', 'BAD TOKEN', 'BAD', 'TOKEN']) assert.equal(r.tables.sku_alias[a], undefined, `${a} is not mapped`);
  assert.equal(r.tables.sku_alias.S2KY1111, undefined, 'a product SKU listed as another product\'s alias is not redirected');
  assert.ok(r.report.warnings.some(w => new RegExp(`${EXPECTED_CONFLICTS.length} conflicting alias`).test(w)) && r.report.warnings.some(w => /1 token\(s\) with whitespace/.test(w)));
});

test('alias sheets: a sheet without either header shape is reported, not guessed', async () => {
  const s = syntheticSheets();
  s.HP_SKU_ALIAS_URL = 'No.,Plant Name,HD Code,Amazon listing\n1,X,4_X,7001\n';
  const r = await buildCatalogTables(s);
  assert.ok(r.report.warnings.includes('HP_SKU_ALIAS_URL: header row not found'));
  assert.equal(r.tables.sku_alias['7001-4-PL'], undefined);
});

test('build.py: the same map and the conflicts, invalid tokens and layouts in its log', { skip: !HAVE_PY }, () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sku-alias-'));
  try {
    for (const f of ['build.py', 'vendor_sheets.py', 'catalog_hook.py', 'deploy_context.py']) fs.copyFileSync(path.join(REPO, f), path.join(work, f));
    const spec = {};
    for (const [k, v] of Object.entries(syntheticSheets())) {
      if (k === 'productExport' || typeof v !== 'string') continue;
      const f = path.join(work, `${k}.src`); fs.writeFileSync(f, v); spec[k] = f;
    }
    fs.writeFileSync(path.join(work, 'sources.json'), JSON.stringify(spec));
    execFileSync('python3', [path.join(REPO, 'tools/catalog-parity/run_build.py'), work, path.join(work, 'sources.json'), path.join(work, 'build.log')],
      { encoding: 'utf8', env: { PATH: process.env.PATH } });
    const log = fs.readFileSync(path.join(work, 'build.log'), 'utf8');
    const aliases = JSON.parse(fs.readFileSync(path.join(work, 'data', 'sku_alias.json'), 'utf8'));
    assert.deepEqual(Object.fromEntries(Object.entries(aliases).filter(([k, v]) => k !== v)), EXPECTED_ALIASES);
    assert.ok(log.includes(`${EXPECTED_CONFLICTS.length} conflicting alias(es) left out`));
    for (const c of EXPECTED_CONFLICTS) assert.ok(log.includes(c), c);
    assert.match(log, /1 alias token\(s\) with whitespace inside left out: SB_SKU_ALIAS_URL_2:BAD TOKEN/);
    assert.match(log, /from SB_SKU_ALIAS_URL_2 \(SB products\)/);
    assert.match(log, /from HP_SKU_ALIAS_URL \(HP products\)/);
    assert.ok(log.includes(`→ ${Object.keys(EXPECTED_ALIASES).length} alias mappings`));
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

test('cost lookup: an alias fills only a SKU with no cost of its own; conflicting aliases stay missing', () => {
  const tables = {
    mcg_total: { S2KY1111: 2, S2KY5555: 3 }, product_costs: {}, sku_weights: {}, sb_costs: { 'EEZZ7620.BR-1': 1.5 }, hp_supplement: { '4_HOYA_SYNTH': 6 },
    hp_by_name: {}, vendor_costs: null, vendor_index: null, mcg_pack: null,
    sku_alias: { ...EXPECTED_ALIASES, 'S2KY5555': 'S2KY1111' },   // a (hypothetical) alias on a SKU that has its own cost
  };
  const a = engineArgsFromCatalog({ tables, mcgExtra: {} });
  const cost = (sku, vendor = 'Succulents Box') => resolveCost(sku, vendor, a.mcgCosts, a.productCosts, a.additionalCosts, a.hpByName, '', a.skuAlias, a.mcgExtra, a.vendorCosts, a.vendorIndex, a.mcgPackCosts)[0];
  assert.equal(cost('9001-2-VAR'), 2, 'alias → MCG SKU');
  assert.equal(cost('E9001-2P'), 3.5, 'alias → bundle SKU, summed like a bundle order');
  assert.equal(cost('H7001-4-PL-BPF', 'Hoya Plant Shop'), 6, 'HP alias → HD SKU');
  assert.equal(cost('S2KY5555'), 3, 'a SKU with its own cost keeps it; the alias is a fallback only');
  assert.equal(cost('9003-2'), null, 'a conflicting alias is not mapped: the cost stays missing (never guessed)');
});

/** The reviewer's case and its neighbours, alone in one SB products tab, through both builders. */
const PRODUCT_ONLY_SHEET = 'MCG SKU,SB Bundles SKU,AMZ SB Alias SKUs\n'
  + 'CANON-A,CANON-A,\n'                 // product A: blank alias cell
  + 'CANON-B,CANON-B,CANON-A\n'          // product B lists A's SKU
  + 'CANON-C,CANON-C,canon-c\n'          // self-only alias (any case)
  + 'CANON-D,CANON-D,"CANON-C\nAMZ-D"\n' // lists C's SKU, and one alias of its own
  + 'PLANT-E,PLANT-E+POT-1,\n'           // bundle row: its MCG SKU is a product SKU too
  + 'CANON-F,CANON-F,PLANT-E\n';
const PRODUCT_ONLY_CONFLICTS = ['CANON-A -> CANON-B (also a product SKU)', 'CANON-C -> CANON-D (also a product SKU)', 'PLANT-E -> CANON-F (also a product SKU)'];

test('alias sheets: a product SKU listed with no aliases (or only itself) is never another product\'s alias (JS builder)', async () => {
  const r = await buildCatalogTables({ SB_SKU_ALIAS_URL_2: PRODUCT_ONLY_SHEET });
  assert.deepEqual(r.report.skuAlias.conflicts, PRODUCT_ONLY_CONFLICTS);
  assert.deepEqual(Object.fromEntries(Object.entries(r.tables.sku_alias).filter(([k, v]) => k !== v)), { 'AMZ-D': 'CANON-D' });
  for (const k of ['CANON-A', 'CANON-C', 'PLANT-E']) assert.notEqual(r.tables.sku_alias[k] && r.tables.sku_alias[k] !== k, true, `${k} is not redirected`);
});

test('alias sheets: the same for build.py', { skip: !HAVE_PY }, () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sku-alias-'));
  try {
    for (const f of ['build.py', 'vendor_sheets.py', 'catalog_hook.py', 'deploy_context.py']) fs.copyFileSync(path.join(REPO, f), path.join(work, f));
    fs.writeFileSync(path.join(work, 'alias.src'), PRODUCT_ONLY_SHEET);
    fs.writeFileSync(path.join(work, 'sources.json'), JSON.stringify({ SB_SKU_ALIAS_URL_2: path.join(work, 'alias.src') }));
    execFileSync('python3', [path.join(REPO, 'tools/catalog-parity/run_build.py'), work, path.join(work, 'sources.json'), path.join(work, 'build.log')],
      { encoding: 'utf8', env: { PATH: process.env.PATH } });
    const log = fs.readFileSync(path.join(work, 'build.log'), 'utf8');
    const aliases = JSON.parse(fs.readFileSync(path.join(work, 'data', 'sku_alias.json'), 'utf8'));
    assert.deepEqual(Object.fromEntries(Object.entries(aliases).filter(([k, v]) => k !== v)), { 'AMZ-D': 'CANON-D' });
    for (const c of PRODUCT_ONLY_CONFLICTS) assert.ok(log.includes(c), c);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});
