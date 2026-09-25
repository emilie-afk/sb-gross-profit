/**
 * C6d in the Worker: register the pinned base, fetch ONLY the five public
 * Products Master tabs (URLs from CATALOG_SOURCES_JSON), overlay, validate,
 * pin, and keep the incomplete-catalog label. Stubbed fetch, synthetic sheets.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, admin, loaded, catalog, WEEK } from './helpers.mjs';
import { syntheticSheets } from '../../tests/fixtures-catalog.mjs';
import { catalogRevOf } from '../../shared/catalog.js';
import { OVERLAY_SOURCES, UNRESOLVED_SOURCES } from '../../shared/catalogOverlay.js';

const MARK = `PUBSHEET${crypto.randomUUID().replace(/-/g, '')}`;
const urlFor = k => `https://docs.google.com/spreadsheets/d/${MARK}/export?format=csv&gid=${OVERLAY_SOURCES.indexOf(k) + 1000}${k.length}`;

function setup({ sheets = syntheticSheets({ scale: true }), omit = [], broken = {} } = {}) {
  const sources = {}, routes = new Map();
  for (const k of OVERLAY_SOURCES) {
    if (omit.includes(k)) continue;
    sources[k] = urlFor(k);
    routes.set(sources[k], broken[k] || (() => new Response(sheets[k], { headers: { 'content-type': 'text/csv' } })));
  }
  sources.MCG_SHEET_URL = `https://docs.google.com/spreadsheets/d/${MARK}/export?format=csv&gid=1`;   // configured, but not live in C6d
  routes.set(sources.MCG_SHEET_URL, () => new Response('SKU,Cost Per Item\nS2KY2965,999\n', { headers: { 'content-type': 'text/csv' } }));
  const calls = [];
  const stub = async url => { calls.push(String(url)); return routes.get(String(url))?.() || new Response('nope', { status: 404 }); };
  return { sources, stub, calls };
}
async function withFetch(stub, fn) { const o = globalThis.fetch; globalThis.fetch = stub; try { return await fn(); } finally { globalThis.fetch = o; } }
const baseTables = () => { const t = catalog().tables; const { vendor_costs: _v, vendor_index: _i, ...rest } = t; return { ...rest, mcg_total: { PLACEHOLDER: 1, S2KY2965: 4.5 }, product_costs: { 'HPX-1': 9 } }; };
const registerBase = (env, tables = baseTables()) => admin(env, 'POST', '/v1/admin/catalog/base', { tables, reason: 'pinned existing cost files (test)', label: 'test base' });
const useBase = (env, rev) => admin(env, 'POST', '/v1/admin/settings', { catalog_overlay_base_rev: rev, reason: 'C6d overlay on the pinned base (test)' });
async function dbText(env) {
  const tables = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).results.map(r => r.name);
  let s = ''; for (const t of tables) s += JSON.stringify((await env.DB.prepare(`SELECT * FROM "${t}"`).all()).results); return s;
}

test('C6d: a base is registered (content-addressed, never active) and the overlay setting requires one', async () => {
  const env = await makeEnv();
  assert.equal((await admin(env, 'POST', '/v1/admin/catalog/base', { tables: baseTables(), reason: 'short' })).status, 400, 'reason required');
  assert.equal((await admin(env, 'POST', '/v1/admin/catalog/base', { tables: { ...baseTables(), vendor_costs: {} }, reason: 'pinned existing cost files (test)' })).json.error, 'base_invalid');
  const r = await registerBase(env);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.baseCatalogRev, await catalogRevOf({ tables: baseTables(), mcgExtra: {}, overrides: {} }));
  assert.equal((await registerBase(env)).json.duplicate, true);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) n FROM cost_catalog WHERE status = 'accepted'").first()).n, 0, 'a base is never the active catalog');
  assert.deepEqual([(await useBase(env, 'cat_0000000000000000')).status, (await useBase(env, 'cat_0000000000000000')).json.error], [409, 'overlay_base_missing']);
  assert.equal((await admin(env, 'POST', '/v1/admin/settings', { catalog_overlay_base_rev: r.json.baseCatalogRev })).status, 400, 'reason required');
  assert.equal((await useBase(env, r.json.baseCatalogRev)).status, 200);
  const audit = await env.DB.prepare("SELECT new_value FROM settings_audit WHERE key = 'catalog_overlay_base_rev' ORDER BY at").all();
  assert.deepEqual(audit.results.map(x => x.new_value), ['null', JSON.stringify(r.json.baseCatalogRev)]);
});

test('C6d: the overlay fetches only the five tabs, keeps every base cost, and labels the catalog incomplete', async () => {
  const { sources, stub, calls } = setup();
  const env = await makeEnv({ CATALOG_SOURCES_JSON: JSON.stringify(sources) });
  const baseRev = (await registerBase(env)).json.baseCatalogRev;
  await useBase(env, baseRev);
  const r = await withFetch(stub, () => admin(env, 'POST', '/v1/admin/catalog/fetch', { weekStart: WEEK }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.mode, r.json.accepted, r.json.refresh.status, r.json.baseCatalogRev], ['vendor_overlay', true, 'fulfilled', baseRev], JSON.stringify(r.json.reasons));
  assert.deepEqual(calls.sort(), OVERLAY_SOURCES.map(urlFor).sort(), 'MCG and every other source are not fetched');
  const row = await env.DB.prepare('SELECT source, status, meta FROM cost_catalog WHERE catalog_rev = ?1').bind(r.json.catalogRev).first();
  assert.deepEqual([row.source, row.status], ['worker_fetch_overlay', 'accepted']);
  const meta = JSON.parse(row.meta);
  assert.equal(meta.completeness.status, 'incomplete');
  assert.deepEqual(meta.completeness.unresolvedSources, [...UNRESOLVED_SOURCES]);
  assert.deepEqual(meta.completeness.resolvedLive, [...OVERLAY_SOURCES]);
  assert.ok(Object.values(meta.costIssues).every(x => Number.isInteger(x.invalid) && Number.isInteger(x.conflicting)));
  // Stored tables: base MCG/HPD untouched (the configured MCG sheet's 999 never arrives), vendor tables present.
  const { loadCatalog } = await import('../src/store.js');
  const cat = await loadCatalog(env.DB, r.json.catalogRev);
  assert.equal(cat.tables.mcg_total.S2KY2965, 4.5);
  assert.deepEqual(cat.tables.hp_supplement, baseTables().hp_supplement);
  assert.equal(cat.tables.product_costs['HPX-1'], 9);
  assert.ok(Object.keys(cat.tables.vendor_costs.LindaMakes).length >= 396);
  for (const s of [JSON.stringify(r.json), await dbText(env)]) assert.ok(!s.includes(MARK), 'the public sheet id never reaches a response or D1');
});

test('C6d: a missing tab, a failed fetch or a shrunken tab rejects the refresh and keeps the current catalog', async () => {
  const good = setup();
  const env = await makeEnv({ CATALOG_SOURCES_JSON: JSON.stringify(good.sources) });
  await useBase(env, (await registerBase(env)).json.baseCatalogRev);
  const first = await withFetch(good.stub, () => admin(env, 'POST', '/v1/admin/catalog/fetch', { weekStart: WEEK }));
  assert.equal(first.json.accepted, true);
  const active = async () => (await env.DB.prepare("SELECT catalog_rev FROM cost_catalog WHERE status = 'accepted' ORDER BY COALESCE(last_pushed_at, captured_at) DESC LIMIT 1").first()).catalog_rev;

  const missing = setup({ omit: ['LINDAMAKES_SHEET_URL'] });
  env.CATALOG_SOURCES_JSON = JSON.stringify(missing.sources);
  const a = await withFetch(missing.stub, () => admin(env, 'POST', '/v1/admin/catalog/fetch', { weekStart: WEEK }));
  assert.deepEqual([a.json.accepted, a.json.reasons], [false, ['overlay_sources_missing: LINDAMAKES_SHEET_URL']]);

  const html = setup({ broken: { CALATHEA_COLLECTIVE_SHEET_URL: () => new Response('<html>sign in</html>', { headers: { 'content-type': 'text/html' } }) } });
  env.CATALOG_SOURCES_JSON = JSON.stringify(html.sources);
  const b = await withFetch(html.stub, () => admin(env, 'POST', '/v1/admin/catalog/fetch', { weekStart: WEEK }));
  assert.deepEqual([b.json.accepted, b.json.reasons], [false, ['CALATHEA_COLLECTIVE_SHEET_URL: html_response']]);

  const empty = setup({ broken: { SURFSIDE_ARRANGEMENT_SHEET_URL: () => new Response('   \n', { headers: { 'content-type': 'text/csv' } }) } });
  env.CATALOG_SOURCES_JSON = JSON.stringify(empty.sources);
  const c = await withFetch(empty.stub, () => admin(env, 'POST', '/v1/admin/catalog/fetch', { weekStart: WEEK }));
  assert.deepEqual([c.json.accepted, c.json.reasons], [false, ['SURFSIDE_ARRANGEMENT_SHEET_URL: empty']]);

  const shrunk = setup({ sheets: syntheticSheets({ scale: true, vendorScale: 0.5 }) });
  env.CATALOG_SOURCES_JSON = JSON.stringify(shrunk.sources);
  const d = await withFetch(shrunk.stub, () => admin(env, 'POST', '/v1/admin/catalog/fetch', { weekStart: WEEK }));
  assert.equal(d.json.accepted, false);
  assert.ok(d.json.reasons.some(x => /decrease|below the expected/.test(x)), JSON.stringify(d.json.reasons));
  assert.equal(await active(), first.json.catalogRev, 'the accepted catalog never changed');
  for (const r of [a, b, c, d]) assert.ok(!JSON.stringify(r.json).includes(MARK));
});

test('C6d: without a base setting the C6 full build is unchanged; a vanished base is refused', async () => {
  const { sources, stub } = setup();
  const env = await makeEnv({ CATALOG_SOURCES_JSON: JSON.stringify(sources) });
  const full = await withFetch(stub, () => admin(env, 'POST', '/v1/admin/catalog/fetch', { weekStart: WEEK }));
  assert.notEqual(full.json.mode, 'vendor_overlay', 'C6 path');
  const baseRev = (await registerBase(env)).json.baseCatalogRev;
  await useBase(env, baseRev);
  await env.DB.prepare("UPDATE cost_catalog SET status = 'retired' WHERE catalog_rev = ?1").bind(baseRev).run();
  const r = await withFetch(stub, () => admin(env, 'POST', '/v1/admin/catalog/fetch', { weekStart: WEEK }));
  assert.deepEqual([r.json.accepted, r.json.reasons], [false, [`overlay_base_missing: ${baseRev}`]]);
});

test('C6d: a week computed on the overlay catalog pins that revision and keeps the incomplete label', async () => {
  const { sources, stub } = setup();
  const { env } = await loaded(20, { CATALOG_SOURCES_JSON: JSON.stringify(sources) }, { verified: false });
  await useBase(env, (await registerBase(env)).json.baseCatalogRev);
  const f = await withFetch(stub, () => admin(env, 'POST', '/v1/admin/catalog/fetch', { weekStart: WEEK }));
  assert.equal(f.json.accepted, true, JSON.stringify(f.json.reasons));
  const run = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  assert.equal(run.status, 200, JSON.stringify(run.json));
  const s = (await admin(env, 'GET', `/v1/snapshot/${WEEK}?includeDrafts=1`)).json;
  assert.equal(s.catalogRev, f.json.catalogRev, 'the week pins the overlay revision');
  const pc = s.totals.labels.c3.disclosures.productCost;
  assert.equal(pc.status, 'incomplete');
  assert.equal(pc.sources.status, 'incomplete');
  assert.equal(pc.sources.unresolvedSources.length, UNRESOLVED_SOURCES.length);
  assert.ok(s.totals.labels.c3.disclosures.labels.includes('Product-cost catalog incomplete'));
  // A later overlay (a tab price changed) becomes the active catalog, but a
  // recompute of this week keeps the pinned revision; moving it needs an
  // audited cost restatement.
  const sheets = syntheticSheets({ scale: true });
  const changed = setup({ sheets: { ...sheets, LINDAMAKES_SHEET_URL: sheets.LINDAMAKES_SHEET_URL.replace(/(LIN-PAD-1,)[0-9.]+/, '$1' + '99.00') } });
  env.CATALOG_SOURCES_JSON = JSON.stringify(changed.sources);
  const g = await withFetch(changed.stub, () => admin(env, 'POST', '/v1/admin/catalog/fetch', { weekStart: WEEK }));
  assert.equal(g.json.accepted, true, JSON.stringify(g.json.reasons));
  assert.notEqual(g.json.catalogRev, f.json.catalogRev);
  const rerun = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  assert.equal(rerun.status, 200, JSON.stringify(rerun.json));
  const s2 = (await admin(env, 'GET', `/v1/snapshot/${WEEK}?includeDrafts=1&revision=2`)).json;
  assert.equal(s2.catalogRev, f.json.catalogRev, 'historical COGS never follow a new catalog automatically');
});
