/**
 * C6: the Worker fetches the cost sheets itself, versions the catalog and
 * never exposes a sheet URL, folder id or API key. Synthetic sheets and a
 * stubbed fetch only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, admin, WEEK } from './helpers.mjs';
import { syntheticSheets } from '../../tests/fixtures-catalog.mjs';
import { buildCatalogTables } from '../../shared/catalogBuild.js';
import { catalogRevOf } from '../../shared/catalog.js';

const SECRET_MARK = `PRIVSHEET${crypto.randomUUID().replace(/-/g, '')}`;
const FOLDER = `PRIVFOLDER${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
const KEY = `PRIVKEY${crypto.randomUUID().replace(/-/g, '')}`;
const urlFor = k => `https://docs.google.com/spreadsheets/d/e/${SECRET_MARK}-${k}/pub?output=csv`;

function setup({ sheets = syntheticSheets({ scale: true }), override = {} } = {}) {
  const sources = {};
  const routes = new Map();
  for (const [k, v] of Object.entries(sheets)) {
    if (k === 'productExport') continue;
    sources[k] = urlFor(k);
    routes.set(sources[k], () => new Response(v, { headers: { 'content-type': 'text/csv' } }));
  }
  sources.HP_COSTS_FOLDER_ID = FOLDER; sources.GDRIVE_API_KEY = KEY;
  const fileId = `fid${SECRET_MARK.slice(-8)}`;
  const drive = url => {
    const u = new URL(url);
    if (u.pathname === '/drive/v3/files' && u.searchParams.get('key') === KEY && u.searchParams.get('q').includes(FOLDER))
      return new Response(JSON.stringify({ files: [{ id: fileId, name: sheets.productExport.name, mimeType: 'text/csv' }] }), { headers: { 'content-type': 'application/json' } });
    if (u.pathname === `/drive/v3/files/${fileId}` && u.searchParams.get('key') === KEY) return new Response(sheets.productExport.text, { headers: { 'content-type': 'text/csv' } });
    return null;
  };
  const calls = [];
  const fetchStub = async (url, init) => {
    calls.push(String(url));
    if (override[url]) return override[url]();
    const r = routes.get(url)?.() || drive(url);
    if (!r) return new Response('nope', { status: 404 });
    return r;
  };
  return { sources, fetchStub, calls, sheets };
}

async function withFetch(stub, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = stub;
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

async function dbText(env) {
  const tables = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).results.map(r => r.name);
  let s = '';
  for (const t of tables) s += JSON.stringify((await env.DB.prepare(`SELECT * FROM "${t}"`).all()).results);
  return s;
}
const assertNoSecrets = (s, what) => { for (const m of [SECRET_MARK, FOLDER, KEY]) assert.ok(!s.includes(m), `${what} leaked a private value`); };

test('the Worker fetches every configured sheet and reproduces the build.py catalog revision', async () => {
  const { sources, fetchStub, sheets } = setup();
  const env = await makeEnv({ CATALOG_SOURCES_JSON: JSON.stringify(sources) });
  const r = await withFetch(fetchStub, () => admin(env, 'POST', '/v1/admin/catalog/fetch', { weekStart: WEEK }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.accepted, true, JSON.stringify(r.json.reasons));
  assert.equal(r.json.refresh.status, 'fulfilled');
  // What build.py reads: decode('utf-8-sig') drops one BOM; the MCG extra sheet keeps it (decode errors='replace').
  const sig = t => t.replace(/^\uFEFF/, '');
  const texts = Object.fromEntries(Object.entries(sheets).filter(([k]) => k !== 'productExport').map(([k, v]) => [k, k === 'MCG_EXTRA_SHEET_URL' ? v : sig(v)]));
  const b = buildCatalogTables({ ...texts, productExport: { ...sheets.productExport, text: sig(sheets.productExport.text) } });
  assert.equal(r.json.catalogRev, await catalogRevOf({ tables: b.tables, mcgExtra: b.mcgExtra, overrides: {} }));
  assert.equal(r.json.provenance.MCG_SHEET_URL.urlSha256.length, 16);
  assert.equal(r.json.provenance.productExport.fileName, sheets.productExport.name);
  const row = await env.DB.prepare('SELECT source, status FROM cost_catalog WHERE catalog_rev = ?1').bind(r.json.catalogRev).first();
  assert.deepEqual([row.source, row.status], ['worker_fetch', 'accepted']);
  assertNoSecrets(JSON.stringify(r.json), 'response');
  assertNoSecrets(await dbText(env), 'D1');
});

test('any failed source rejects the refresh and imports nothing; codes, never URLs', async () => {
  const bad = { [urlFor('LINDAMAKES_SHEET_URL')]: () => new Response('denied', { status: 403 }),
                [urlFor('HP_SHEET_URL')]: () => new Response('<!DOCTYPE html><title>Sign in</title>', { headers: { 'content-type': 'text/html' } }),
                [urlFor('AS_SHEET_URL')]: () => { throw new TypeError(`fetch failed for ${urlFor('AS_SHEET_URL')}`); },
                [urlFor('SB_SKU_ALIAS_URL')]: () => new Response('  \n', { headers: { 'content-type': 'text/csv' } }),
                [urlFor('MCG_POTS_SHEET_URL')]: () => new Response('<html>signin</html>', { headers: { 'content-type': 'text/plain' } }) };
  const { sources, fetchStub } = setup({ override: bad });
  const env = await makeEnv({ CATALOG_SOURCES_JSON: JSON.stringify(sources) });
  const r = await withFetch(fetchStub, () => admin(env, 'POST', '/v1/admin/catalog/fetch', { weekStart: WEEK }));
  assert.equal(r.status, 200);
  assert.equal(r.json.accepted, false);
  assert.deepEqual(r.json.reasons, ['AS_SHEET_URL: network_error', 'HP_SHEET_URL: html_response', 'LINDAMAKES_SHEET_URL: http_403',
                                    'MCG_POTS_SHEET_URL: html_response', 'SB_SKU_ALIAS_URL: empty']);
  assert.equal(r.json.refresh.status, 'rejected');
  assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM cost_catalog').first()).n, 0);
  assertNoSecrets(JSON.stringify(r.json), 'response');
  assertNoSecrets(await dbText(env), 'D1');
});

test('an empty or reduced catalog never replaces the accepted one', async () => {
  const first = setup();
  const env = await makeEnv({ CATALOG_SOURCES_JSON: JSON.stringify(first.sources) });
  const a = await withFetch(first.fetchStub, () => admin(env, 'POST', '/v1/admin/catalog/fetch', { weekStart: WEEK }));
  assert.equal(a.json.accepted, true);
  const shrunk = setup({ sheets: syntheticSheets({ scale: true, vendorScale: 0.5 }) });
  const b = await withFetch(shrunk.fetchStub, () => admin(env, 'POST', '/v1/admin/catalog/fetch', { weekStart: WEEK }));
  assert.equal(b.json.accepted, false);
  assert.ok(b.json.reasons.some(x => /Calathea Collective/.test(x)));
  assert.equal(b.json.activeCatalogRev, a.json.catalogRev);
  const noExport = setup();
  delete noExport.sources.HP_COSTS_FOLDER_ID; delete noExport.sources.GDRIVE_API_KEY;
  env.CATALOG_SOURCES_JSON = JSON.stringify(noExport.sources);
  const c = await withFetch(noExport.fetchStub, () => admin(env, 'POST', '/v1/admin/catalog/fetch', { weekStart: WEEK }));
  assert.equal(c.json.accepted, false, 'losing the product-export tables is a shrink');
  assert.ok(c.json.reasons.some(x => /^sb_costs: 0 entries/.test(x)), JSON.stringify(c.json.reasons));
  const active = await env.DB.prepare("SELECT catalog_rev FROM cost_catalog WHERE status = 'accepted'").all();
  assert.deepEqual(active.results.map(x => x.catalog_rev), [a.json.catalogRev]);
});

test('a named refresh is resolved exactly; a resolved one cannot be answered again', async () => {
  const { sources, fetchStub } = setup();
  const env = await makeEnv({ CATALOG_SOURCES_JSON: JSON.stringify(sources) });
  const one = (await admin(env, 'POST', '/v1/admin/catalog-refresh', { weekStart: WEEK })).json.refreshId;
  const two = (await admin(env, 'POST', '/v1/admin/catalog-refresh', { weekStart: WEEK })).json.refreshId;
  const r = await withFetch(fetchStub, () => admin(env, 'POST', '/v1/admin/catalog/fetch', { refreshId: one }));
  assert.deepEqual([r.json.refresh.refreshId, r.json.refresh.status], [one, 'fulfilled']);
  assert.equal((await env.DB.prepare('SELECT status FROM catalog_refresh WHERE refresh_id = ?1').bind(two).first()).status, 'pending');
  const again = await withFetch(fetchStub, () => admin(env, 'POST', '/v1/admin/catalog/fetch', { refreshId: one }));
  assert.deepEqual([again.status, again.json.error], [409, 'refresh_resolved']);
  assert.equal((await admin(env, 'POST', '/v1/admin/catalog/fetch', { refreshId: 'crf_nothex' })).status, 400);
});

test('the sources secret is checked without ever echoing a value', async () => {
  const env = await makeEnv();
  const none = await admin(env, 'POST', '/v1/admin/catalog/fetch', { weekStart: WEEK });
  assert.deepEqual([none.status, none.json.error], [409, 'catalog_sources_unconfigured']);
  for (const [sources, pattern] of [
    [{ MCG_SHEET_URL: `http://docs.google.com/${SECRET_MARK}` }, /MCG_SHEET_URL must be an https/],
    [{ MCG_SHEET_URL: `https://evil.example/${SECRET_MARK}` }, /MCG_SHEET_URL must be an https/],
    [{ NOT_A_SOURCE: SECRET_MARK }, /Unknown source names: NOT_A_SOURCE/],
    [{ HP_COSTS_FOLDER_ID: FOLDER }, /go together/],
    [{ PRODUCT_COSTS_JSON1: `[${SECRET_MARK}` }, /PRODUCT_COSTS_JSON1 must be a JSON object/],
  ]) {
    env.CATALOG_SOURCES_JSON = JSON.stringify(sources);
    const r = await admin(env, 'POST', '/v1/admin/catalog/fetch', { weekStart: WEEK });
    assert.equal(r.status, 500);
    assert.match(r.json.message, pattern);
    assertNoSecrets(JSON.stringify(r.json), 'error');
  }
  assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM catalog_refresh').first()).n, 0, 'no refresh is created for a bad secret');
});

test('a sheet CPython could not parse is a rejected refresh, not a partial catalog', async () => {
  const sheets = syntheticSheets({ scale: true });
  sheets.MCG_SHEET_URL = 'SKU,Description,Cost Per Item\nA1,x\ry,4\n';
  const { sources, fetchStub } = setup({ sheets });
  const env = await makeEnv({ CATALOG_SOURCES_JSON: JSON.stringify(sources) });
  const r = await withFetch(fetchStub, () => admin(env, 'POST', '/v1/admin/catalog/fetch', { weekStart: WEEK }));
  assert.deepEqual([r.json.accepted, r.json.reasons], [false, ['parse_failed: csv_newline_in_field']]);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM cost_catalog').first()).n, 0);
});

test('the Lively Root tab replaces the fixed list only after a fetch shows they match; the switch is audited', async () => {
  const { MANUAL_LR_COSTS } = await import('../../shared/catalogManual.js');
  const { livelyRootTab } = await import('../../tests/fixtures-catalog.mjs');
  const [k0, v0] = MANUAL_LR_COSTS[0];
  const env = await makeEnv();
  const toSheet = () => admin(env, 'POST', '/v1/admin/settings', { lively_root_cost_source: 'sheet', reason: 'tab verified against list (test)' });
  assert.equal((await toSheet()).status, 409, 'no fetch yet');

  const differs = setup({ sheets: { ...syntheticSheets({ scale: true }), LIVELY_GOOD_SHEET_URL: livelyRootTab(MANUAL_LR_COSTS, { change: { [k0]: v0 + 2 } }) } });
  env.CATALOG_SOURCES_JSON = JSON.stringify(differs.sources);
  const a = await withFetch(differs.fetchStub, () => admin(env, 'POST', '/v1/admin/catalog/fetch', { weekStart: WEEK }));
  assert.equal(a.json.accepted, true, JSON.stringify(a.json.reasons));
  assert.equal(a.json.livelyRoot.comparison.changed, 1);
  const refused = await toSheet();
  assert.deepEqual([refused.status, refused.json.error], [409, 'lively_root_not_verified']);

  const same = setup({ sheets: { ...syntheticSheets({ scale: true }), LIVELY_GOOD_SHEET_URL: livelyRootTab(MANUAL_LR_COSTS) } });
  env.CATALOG_SOURCES_JSON = JSON.stringify(same.sources);
  const b = await withFetch(same.fetchStub, () => admin(env, 'POST', '/v1/admin/catalog/fetch', { weekStart: WEEK }));
  assert.equal(b.json.livelyRoot.comparison.identical, true);
  assert.equal((await admin(env, 'POST', '/v1/admin/settings', { lively_root_cost_source: 'sheet' })).status, 400, 'reason required');
  assert.equal((await toSheet()).status, 200);
  const audit = await env.DB.prepare("SELECT new_value FROM settings_audit WHERE key = 'lively_root_cost_source'").all();
  assert.deepEqual(audit.results.map(r => r.new_value), ['"sheet"']);

  // After the switch, a tab edit reaches mcg_total on the next fetch.
  env.CATALOG_SOURCES_JSON = JSON.stringify(differs.sources);
  const c = await withFetch(differs.fetchStub, () => admin(env, 'POST', '/v1/admin/catalog/fetch', { weekStart: WEEK }));
  assert.equal(c.json.accepted, true);
  assert.notEqual(c.json.catalogRev, a.json.catalogRev, 'same sheets as fetch a, but mcg_total now follows the tab');
  assert.equal(c.json.livelyRoot.mode, 'sheet');
  assertNoSecrets(JSON.stringify(c.json), 'response');
});
