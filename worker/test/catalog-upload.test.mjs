/**
 * Chunked cost-catalog upload (Workers Free): build.py's chunker (catalog_push.py, run with the
 * real Python) → the Worker's chunk routes. The stored catalog equals the pushed one exactly, a
 * repeat push is a duplicate, validation equals the one-request push, broken uploads are refused,
 * and a week computed with the chunked catalog verifies and reads exactly like before.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, ok, dataset, freeTierRun, freeTierEnv, client, runVerifier, dashboardView, mask } from './freeTierHarness.mjs';
import * as FT from '../../automation/collector/src/freeTier.mjs';
import { catalogCandidate } from '../../tests/fixtures-free-tier.mjs';
import { catalogFromParts } from '../../shared/bundle.js';
import { catalogPartsRevOf, validateCatalog } from '../../shared/catalog.js';
import { stableStringify } from '../../shared/normalized.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HAVE_PY = spawnSync('python3', ['--version']).status === 0;
const chunk = tables => JSON.parse(execFileSync('python3', [path.join(REPO, 'catalog_push.py')], { input: JSON.stringify({ tables }), encoding: 'utf8', maxBuffer: 64 << 20 }));

/** A catalog the size of the real one (~360 KB; vendor_costs ~190 KB), keeping the fixture's SKUs. */
function bigCatalog({ drop = null } = {}) {
  const c = catalogCandidate();
  for (const [t, n] of [['mcg_total', 744], ['product_costs', 754], ['sku_weights', 651], ['hp_supplement', 1283], ['hp_by_name', 420]]) {
    for (let i = 0; i < n; i++) c.tables[t][`${t.toUpperCase()}-${String(i).padStart(5, '0')}`] = Math.round(i * 37.3) / 100 + 1;
  }
  for (const [v, n] of [['Live to Give', 30], ['Lively Good', 171], ['Calathea Collective', 472], ['Surfside Arrangement', 11], ['LindaMakes', 396]]) {
    c.tables.vendor_costs[v] ||= {};
    for (let i = 0; i < n; i++) c.tables.vendor_costs[v][`${v.slice(0, 3).toUpperCase()}-X${i}`] = { unitCost: Math.round(i * 13.7) / 100 + 2, product: `Synthetic plant ${i}`, size: '4in', note: null };
  }
  if (drop) delete c.tables.vendor_costs[drop];
  return c;
}
async function push(env, tables, { mutate = x => x } = {}) {
  const { layout, chunks } = mutate(chunk(tables));
  const opened = await ok(api(env, 'POST', '/v1/ingest/catalog/uploads', { layout, meta: { builtAt: '2026-10-01T00:00:00Z', commit: 'test' } }, 'ingest'), 'open');
  for (const c of chunks) {
    const r = await api(env, 'PUT', `/v1/ingest/catalog/uploads/${opened.uploadId}/chunks/${c.table}/${c.part}`, { entries: c.entries, ...(c.group !== null ? { group: c.group } : {}) }, 'ingest');
    if (r.status >= 300) return { error: r.json?.error, at: 'chunk' };
  }
  const s = await api(env, 'POST', `/v1/ingest/catalog/uploads/${opened.uploadId}/seal`, {}, 'ingest');
  return s.status >= 300 ? { error: s.json?.error, at: 'seal' } : { ...s.json, chunks: chunks.length, maxChunk: Math.max(...chunks.map(c => JSON.stringify(c.entries).length)) };
}
const storedParts = async (env, rev) => ((await env.DB.prepare('SELECT table_name, part, payload FROM cost_catalog_part WHERE catalog_rev = ?1').bind(rev).all()).results || []).map(r => [r.table_name, r.part, r.payload]);

test('chunked catalog: the stored catalog equals the pushed one; a repeat push is a duplicate', { skip: !HAVE_PY }, async () => {
  const d = dataset({ n: 60 });
  const ft = await freeTierRun(d, { verify: false });
  const env = ft.env, cat = bigCatalog();
  const r = await push(env, cat.tables);
  assert.equal(r.accepted, true, JSON.stringify(r));
  assert.ok(r.chunks >= 8 && r.maxChunk <= 96 * 1024, `${r.chunks} chunks, largest ${r.maxChunk} chars`);
  const parts = await storedParts(env, r.catalogRev);
  const back = catalogFromParts(r.catalogRev, parts);
  assert.equal(stableStringify(back.tables), stableStringify(cat.tables), 'every table, exactly');
  assert.deepEqual([back.mcgExtra, back.overrides], [{}, {}]);
  assert.equal(await catalogPartsRevOf(parts), r.catalogRev, 'the revision is the hash of its parts');
  const legacy = validateCatalog({ tables: cat.tables, mcgExtra: {}, overrides: {} }, null);
  assert.deepEqual(r.counts, legacy.counts, 'the same counts as the one-request push');
  const before = (await env.DB.prepare('SELECT COUNT(*) AS n FROM cost_catalog').first()).n;
  const again = await push(env, cat.tables);
  assert.deepEqual([again.catalogRev, again.duplicates], [r.catalogRev, 1]);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM cost_catalog').first()).n, before, 'no new catalog row');
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM catalog_upload_part').first()).n, 0, 'upload fragments are cleared at seal');
});

test('chunked catalog: validation as the one-request push; out-of-order, missing or mismatched chunks are refused', { skip: !HAVE_PY }, async () => {
  const env = (await freeTierRun(dataset({ n: 60 }), { verify: false })).env;
  assert.equal((await push(env, bigCatalog().tables)).accepted, true);
  // A vendor gone: rejected for the same reasons the one-request push gives, and never active.
  const shrunk = bigCatalog({ drop: 'LindaMakes' });
  const r = await push(env, shrunk.tables);
  const prev = await env.DB.prepare("SELECT table_counts, vendor_counts FROM cost_catalog WHERE status = 'accepted' ORDER BY COALESCE(last_pushed_at, captured_at) DESC LIMIT 1").first();
  const legacy = validateCatalog({ tables: shrunk.tables, mcgExtra: {}, overrides: {} }, { tableCounts: JSON.parse(prev.table_counts), vendorCounts: JSON.parse(prev.vendor_counts) });
  assert.equal(r.accepted, false);
  assert.deepEqual(r.reasons, legacy.reasons);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM cost_catalog_part WHERE catalog_rev = ?1').bind(r.catalogRev).first()).n, 0, 'a rejected catalog stores no parts');
  // Broken uploads.
  const swap = x => { const k = x.chunks.findIndex((c, i) => i > 0 && x.chunks[i - 1].table === c.table && x.chunks[i - 1].group === c.group);
    assert.ok(k > 0, 'a table or group with two chunks'); [x.chunks[k - 1].entries, x.chunks[k].entries] = [x.chunks[k].entries, x.chunks[k - 1].entries]; return x; };
  assert.deepEqual(await push(env, bigCatalog().tables, { mutate: swap }), { error: 'chunk_order', at: 'seal' });
  const missing = x => ({ ...x, chunks: x.chunks.filter(k => !(k.table === 'mcg_total' && k.part === 0)) });
  assert.deepEqual(await push(env, bigCatalog().tables, { mutate: missing }), { error: 'chunks_missing', at: 'seal' });
  const wrongGroup = x => { const k = x.chunks.find(c => c.table === 'vendor_costs'); k.group = 'Not a vendor'; return x; };
  assert.deepEqual(await push(env, bigCatalog().tables, { mutate: wrongGroup }), { error: 'bad_payload', at: 'chunk' });
  const customer = x => { x.chunks[0].entries = { ...x.chunks[0].entries, zzz: { email: 'synthetic@example.invalid' } }; return x; };
  assert.deepEqual(await push(env, bigCatalog().tables, { mutate: customer }), { error: 'customer_data_rejected', at: 'chunk' });
  const big = await api(env, 'POST', '/v1/ingest/catalog/uploads', { layout: [['mcg_total', 1, 1]], meta: {} }, 'ingest');
  const huge = Object.fromEntries(Array.from({ length: 2500 }, (_, i) => [`K${String(i).padStart(5, '0')}`, i]));
  assert.equal((await api(env, 'PUT', `/v1/ingest/catalog/uploads/${big.json.uploadId}/chunks/mcg_total/0`, { entries: huge }, 'ingest')).status, 400, 'too many entries in one chunk');
});

test('chunked catalog: a week computed with it verifies and reads exactly as with the one-request catalog', { skip: !HAVE_PY }, async () => {
  const d = dataset({ n: 120, scr: { zeroEvery: 1e9 } });
  const week = d.weeks[7];
  const ref = await freeTierRun(d, { verify: false });                       // the fixture catalog pushed in one request
  // The same setup, with the same catalog pushed in chunks.
  const env = await freeTierEnv();
  await ok(api(env, 'POST', '/v1/admin/settings', { carrier_fee_priority_locked: true, reason: 'test: priority locked' }), 'settings');
  const r = await push(env, d.catalog.tables);
  assert.equal(r.accepted, true, JSON.stringify(r));
  await ok(api(env, 'POST', '/v1/ingest/shipstation', { format: 'rows', rows: d.ss, weekStart: d.week.weekStart }, 'ingest'), 'shipstation');
  await ok(api(env, 'POST', '/v1/ingest/hpd', { format: 'normalized', hpdOrders: d.hpd }, 'ingest'), 'hpd');
  const c = client(env);
  const scr = await FT.uploadShippingCostReport(c, d.scr);
  await ok(api(env, 'POST', `/v1/admin/scr/versions/${scr.versionId}/accept`, { reason: 'test: first version reviewed' }), 'accept');
  const orders = await FT.uploadShopifyOrders(c, d.shopify);
  const res = await FT.computeAndUploadWeek(c, week, FT.newCache(orders.bodies));
  assert.equal(res.status, 'computed');
  const v = await runVerifier(env, res.snapshotId);
  assert.equal(v.body.status, 'verified', JSON.stringify(v.body));
  const before = await dashboardView(ref.env, week), after = await dashboardView(env, week);
  const rowsOf = x => ({ lists: Object.fromEntries(Object.entries(x.lists).map(([k, l]) => [k, l.orders])), details: x.details.map(y => [y.order, y.lines]),
                         issues: x.issues.issues, scenario: x.scenario.lines, totals: x.snap.totals });
  // The catalog revision differs by definition (parts hash vs content hash); everything else must not.
  const a = mask(rowsOf(after)).replace(/cat_[0-9a-f]{16}/g, 'cat*'), b = mask(rowsOf(before)).replace(/cat_[0-9a-f]{16}/g, 'cat*');
  if (a !== b) { let i = 0; while (a[i] === b[i]) i++; assert.fail(`differ at …${b.slice(Math.max(0, i - 150), i + 60)}… vs …${a.slice(Math.max(0, i - 150), i + 60)}…`); }
});
