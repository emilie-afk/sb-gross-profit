/**
 * C6: the Worker's catalog builder reproduces build.py exactly.
 * Synthetic sheets only, written to a temporary directory outside the repo.
 * The Python side runs the real build.py / vendor_sheets.py with no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pyCsvRows, pyFloat, pyRound, pyStrip } from '../shared/pyCompat.js';
import { buildCatalogTables } from '../shared/catalogBuild.js';
import { runParity } from '../tools/catalog-parity/parity.mjs';
import { syntheticSheets } from './fixtures-catalog.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HAVE_PY = spawnSync('python3', ['--version']).status === 0;
const py = (code, input) => execFileSync('python3', ['-c', code], { input, encoding: 'utf8' });

function writeSources(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-src-'));
  const spec = {};
  for (const [k, v] of Object.entries(files)) {
    if (k === 'productExport') { fs.writeFileSync(path.join(dir, 'export.csv'), v.text); spec.productExport = { name: v.name, path: 'export.csv' }; }
    else { fs.writeFileSync(path.join(dir, `${k}.src`), v); spec[k] = `${k}.src`; }
  }
  fs.writeFileSync(path.join(dir, 'sources.json'), JSON.stringify(spec));
  return { dir, file: path.join(dir, 'sources.json') };
}

test('manual cost constants match build.py', { skip: !HAVE_PY }, () => {
  assert.equal(spawnSync('python3', [path.join(REPO, 'tools/catalog-parity/gen-manual.py'), '--check']).status, 0, 'run gen-manual.py');
});

test('csv parsing matches CPython csv.reader on awkward input', { skip: !HAVE_PY }, () => {
  const cases = ['a,b\r\nc,d\r\n', 'a,"b\r\nc",d\n', '"a"b,c\n', 'a"b,c\n', '\n\n,\n', '"unterminated\nx', 'x,y', '"",""\n', ' a , b \n', '\ufeffh1,h2\nv,"q""q"\n'];
  for (const c of cases) {
    const expected = JSON.parse(py('import csv,io,sys,json; print(json.dumps(list(csv.reader(io.StringIO(sys.stdin.read())))))', c));
    assert.deepEqual(pyCsvRows(c), expected, JSON.stringify(c));
  }
});

test('float(), round(x, 4) and str.strip() match CPython', { skip: !HAVE_PY }, () => {
  const inputs = ['4.5', ' 5 ', '1_0', '1e3', '.5', '5.', 'nan', '-inf', 'Infinity', '', 'abc', '1__0', '_1', '1.2.3', '+3', '0x10', ' 12 '];
  const expected = JSON.parse(py('import sys,json\nout=[]\nfor s in json.loads(sys.stdin.read()):\n  try:\n    v=float(s); out.append(repr(v))\n  except ValueError: out.append(None)\nprint(json.dumps(out))', JSON.stringify(inputs)));
  const repr = v => (v === null ? null : Number.isNaN(v) ? 'nan' : v === Infinity ? 'inf' : v === -Infinity ? '-inf' : Number.isInteger(v) ? `${v}.0` : String(v));
  assert.deepEqual(inputs.map(s => repr(pyFloat(s))), expected);
  const nums = [0.03125, 0.00015, 2.00005, 1.23456789, 29.99, 0.1 + 0.2, 1 / 3, 12.34565, 5];
  const r = JSON.parse(py('import sys,json; print(json.dumps([round(x,4) for x in json.loads(sys.stdin.read())]))', JSON.stringify(nums)));
  assert.deepEqual(nums.map(x => pyRound(x, 4)), r);
  const ws = ['\x1c a \x1f', '\u0085b\u0085', '\ufeffc', '　d '];
  assert.deepEqual(ws.map(pyStrip), JSON.parse(py('import sys,json; print(json.dumps([s.strip() for s in json.loads(sys.stdin.read())]))', JSON.stringify(ws))));
});

test('build.py parity: every table and the catalog revision are identical (full source set)', { skip: !HAVE_PY }, async () => {
  const { dir, file } = writeSources(syntheticSheets());
  try {
    const r = await runParity(file, { allowFixtures: true });
    assert.ok(r.identical, JSON.stringify(r.tables));
    assert.equal(r.buildPyCatalogRev, r.workerCatalogRev);
    for (const t of ['mcg_total', 'product_costs', 'sku_weights', 'sb_costs', 'hp_supplement', 'hp_by_name', 'sku_alias', 'vendor_costs', 'vendor_index', 'mcgExtra']) assert.ok(r.tables[t].buildPy > 0, t);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('build.py parity: HP JSON fallback and no product export (tables omitted like build.py)', { skip: !HAVE_PY }, async () => {
  const s = syntheticSheets();
  delete s.HP_SHEET_URL; delete s.productExport; delete s.MCG_EXTRA_SHEET_URL; delete s.SB_SKU_ALIAS_URL_2;
  s.PRODUCT_COSTS_JSON1 = JSON.stringify({ 'HPX-1': 3.5, '777': 2 });
  s.PRODUCT_COSTS_JSON2 = JSON.stringify({ 'HPX-1': 4.25 });
  s.SKU_WEIGHTS_JSON = JSON.stringify({ 'HPX-1': 1.5 });
  const { dir, file } = writeSources(s);
  try {
    const r = await runParity(file, { allowFixtures: true });
    assert.ok(r.identical, JSON.stringify(r.tables));
    assert.equal(r.tables.sb_costs, undefined, 'neither side has an sb_costs table');
    assert.ok(!('sb_costs' in r.jsCandidate.tables));
    assert.equal(r.jsCandidate.tables.product_costs['777'], 2);
    assert.equal(r.jsCandidate.tables.sku_weights['HPX-1'], 1.5);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('first-wins indexes keep sheet order even for number-like SKUs', () => {
  const s = syntheticSheets();
  const { tables } = buildCatalogTables(s);
  assert.equal(tables.vendor_index['Calathea Collective'].byLooseSku['100'], '1-00', 'the earlier row wins, as in Python');
  assert.equal(tables.vendor_costs['Calathea Collective']['CC-TIE'].unitCost, 0.0312, 'round half to even');
  assert.equal(tables.vendor_costs['Live to Give']['L2G-CONFLICT'], undefined, 'conflicting duplicates are withheld');
});

test('a source CPython could not parse is refused, never guessed', () => {
  const s = syntheticSheets();
  s.MCG_SHEET_URL = 'SKU,Description,Cost Per Item\nA1,x\ry,4\n';
  assert.throws(() => buildCatalogTables(s), e => e.code === 'csv_newline_in_field');
  const t = syntheticSheets();
  t.AS_SHEET_URL = 'SKU ,Fullfilled Price\nAS-INF,inf\n';
  assert.throws(() => buildCatalogTables(t), e => e.code === 'non_finite_cost');
});

test('the parity tool refuses real-looking source files inside the repository', async () => {
  const f = path.join(REPO, 'tests', 'parity-refusal.tmp.json');
  fs.writeFileSync(f, JSON.stringify({ MCG_SHEET_URL: 'build.py' }));
  try { await assert.rejects(runParity(f), /inside the repository/); } finally { fs.rmSync(f); }
});

test('Lively Root tab: parsed from columns E/G/Q, compared with the fixed list, used only in sheet mode', async () => {
  const { MANUAL_LR_COSTS } = await import('../shared/catalogManual.js');
  const { livelyRootTab } = await import('./fixtures-catalog.mjs');
  const same = { ...syntheticSheets(), LIVELY_ROOT_SHEET_URL: livelyRootTab(MANUAL_LR_COSTS) };
  const a = buildCatalogTables(same);
  assert.deepEqual(a.report.livelyRoot.columns, { sku: 'E', cost: 'G', listed: 'Q' });
  assert.equal(a.report.livelyRoot.comparison.identical, true);
  assert.equal(a.report.livelyRoot.stats.notListed, 1);
  const noTab = buildCatalogTables(syntheticSheets());
  assert.deepEqual(a.tables, noTab.tables, 'manual_list mode ignores the tab: build.py parity holds');
  assert.deepEqual(buildCatalogTables(same, { livelyRootSource: 'sheet' }).tables, noTab.tables, 'an identical tab gives identical tables');

  const [k0, v0] = MANUAL_LR_COSTS[0], [k1] = MANUAL_LR_COSTS[1];
  const edited = { ...syntheticSheets(), LIVELY_ROOT_SHEET_URL: livelyRootTab(MANUAL_LR_COSTS, { change: { [k0]: v0 + 1 }, drop: [k1], extra: [['PL_SYN_NEW_6IN1', 40]] }) };
  const b = buildCatalogTables(edited);
  assert.deepEqual([b.report.livelyRoot.comparison.changed, b.report.livelyRoot.comparison.onlyManualList, b.report.livelyRoot.comparison.onlySheet, b.report.livelyRoot.comparison.identical], [1, 1, 1, false]);
  assert.equal(b.tables.mcg_total[k0], v0, 'manual_list mode keeps the fixed list');
  const c = buildCatalogTables(edited, { livelyRootSource: 'sheet' });
  assert.equal(c.tables.mcg_total[k0], Math.round((v0 + 1) * 100) / 100);
  assert.equal(c.tables.mcg_total.PL_SYN_NEW_6IN1, 40);
  assert.equal(c.tables.mcg_total.PL_SYN_NOTLISTED, undefined, 'unlisted rows are never imported');
  assert.throws(() => buildCatalogTables(syntheticSheets(), { livelyRootSource: 'sheet' }), e => e.code === 'lively_root_unavailable');
});
