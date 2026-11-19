/**
 * Chunked cost-catalog upload (Workers Free): build.py's chunker (catalog_push.py, run with the
 * real Python) → the Worker's chunk routes. The stored catalog equals the pushed one exactly, a
 * repeat push is a duplicate, validation equals the one-request push, broken uploads are refused,
 * and a week computed with the chunked catalog verifies and reads exactly like before.
 */
import { MIN } from './helpers.mjs';
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
  for (const [v, n] of Object.entries(MIN()).map(([v, n]) => [v, v === 'CC' ? n + 10 : n])) {
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
  const shrunk = bigCatalog({ drop: 'LM' });
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

/** The real shape since Oct 13: CC's vendor_index entry alone is ~147 KB (2,631 SKUs). */
function bigIndexCatalog() {
  const c = bigCatalog();
  const index = (v, n) => ({
    byLooseSku: Object.fromEntries(Array.from({ length: n }, (_, i) => [`${v.slice(0, 3).toUpperCase()}X${i}`, `${v.slice(0, 3).toUpperCase()}-X${i}`])),
    byName: Object.fromEntries(Array.from({ length: n }, (_, i) => [`synthetic plant ${i} 4in`, `${v.slice(0, 3).toUpperCase()}-X${i}`])),
  });
  c.tables.vendor_index = { 'CC': index('CC', 2631), LM: index('LM', MIN().LM), 'L2G': index('L2G', MIN()['L2G']) };
  return c;
}

test('chunked catalog: a vendor_index entry larger than the 96 KB chunk limit is split per field and stored exactly', { skip: !HAVE_PY }, async () => {
  const env = (await freeTierRun(dataset({ n: 60 }), { verify: false })).env;
  const cat = bigIndexCatalog();
  assert.ok(JSON.stringify(cat.tables.vendor_index['CC']).length > 96 * 1024, 'the fixture reproduces the oversized entry');
  const { layout, chunks } = chunk(cat.tables);
  const vi = layout.find(e => e[0] === 'vendor_index');
  assert.equal(vi[1], 3, 'vendor_index goes one level deeper');
  assert.deepEqual(vi[2].map(([v, subs]) => [v, subs.map(([f]) => f)]),
    [['CC', ['byLooseSku', 'byName']], ['L2G', ['byLooseSku', 'byName']], ['LM', ['byLooseSku', 'byName']]]);
  assert.ok(chunks.every(c => JSON.stringify({ entries: c.entries, group: c.group }).length <= 96 * 1024), 'every chunk request is under the limit');
  const r = await push(env, cat.tables);
  assert.equal(r.accepted, true, JSON.stringify(r));
  const back = catalogFromParts(r.catalogRev, await storedParts(env, r.catalogRev));
  assert.equal(stableStringify(back.tables), stableStringify(cat.tables), 'every table, exactly');
  const legacy = validateCatalog({ tables: cat.tables, mcgExtra: {}, overrides: {} }, null);
  assert.deepEqual(r.counts, legacy.counts, 'the same counts as the one-request push (vendor_index counts vendors)');
  // The same catalog pushed again is a duplicate (same chunks, same revision).
  assert.deepEqual([(await push(env, cat.tables)).catalogRev], [r.catalogRev]);
});

test('chunked catalog: depth-3 uploads are checked like depth 2; an older depth-1 vendor_index still works', { skip: !HAVE_PY }, async () => {
  const env = (await freeTierRun(dataset({ n: 60 }), { verify: false })).env;
  const cat = bigIndexCatalog();
  // A chunk naming another vendor or field than the layout, or a bare string group: refused at the chunk.
  for (const g of [['LM', 'byLooseSku'], ['CC', 'byNames'], 'CC']) {
    const wrong = x => { const k = x.chunks.find(c => c.table === 'vendor_index'); k.group = g; return x; };
    assert.deepEqual(await push(env, cat.tables, { mutate: wrong }), { error: 'bad_payload', at: 'chunk' }, JSON.stringify(g));
  }
  // Swapped entries inside one field, or a field missing: refused at the seal.
  const swap = x => { const k = x.chunks.findIndex((c, i) => i > 0 && c.table === 'vendor_index' && JSON.stringify(x.chunks[i - 1].group) === JSON.stringify(c.group));
    [x.chunks[k - 1].entries, x.chunks[k].entries] = [x.chunks[k].entries, x.chunks[k - 1].entries]; return x; };
  assert.deepEqual(await push(env, cat.tables, { mutate: swap }), { error: 'chunk_order', at: 'seal' });
  const missing = x => ({ ...x, chunks: x.chunks.filter(c => !(c.table === 'vendor_index' && c.group[1] === 'byName' && c.group[0] === 'LM')) });
  assert.deepEqual(await push(env, cat.tables, { mutate: missing }), { error: 'chunks_missing', at: 'seal' });
  // Layout errors: sub-groups out of order, a sub-group with no chunks, depth 2 for vendor_index.
  for (const bad of [
    [['vendor_index', 3, [['A', [['byName', 1], ['byLooseSku', 1]]]]]],
    [['vendor_index', 3, [['A', [['byLooseSku', 0]]]]]],
    [['vendor_index', 3, [['A', []]]]],
    [['vendor_index', 2, [['A', 1]]]],
  ]) assert.equal((await api(env, 'POST', '/v1/ingest/catalog/uploads', { layout: bad, meta: {} }, 'ingest')).status, 400, JSON.stringify(bad));
  // An older build.py sends vendor_index at depth 1: accepted when it fits (and stored identically).
  const small = bigCatalog();
  const old = x => {
    const vi = x.layout.find(e => e[0] === 'vendor_index');
    const t = small.tables.vendor_index;
    vi[1] = 1; vi[2] = 1;
    const first = x.chunks.findIndex(c => c.table === 'vendor_index');
    const rest = x.chunks.filter(c => c.table !== 'vendor_index');
    rest.splice(first, 0, { table: 'vendor_index', part: 0, group: null, entries: t });
    return { ...x, chunks: rest };
  };
  const r = await push(env, small.tables, { mutate: old });
  assert.equal(r.accepted, true, JSON.stringify(r));
  const back = catalogFromParts(r.catalogRev, await storedParts(env, r.catalogRev));
  assert.equal(stableStringify(back.tables), stableStringify(small.tables));
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

test('correction catalog: validated against its own base, accepted after an ordinary rejection, never the catalog new weeks use', { skip: !HAVE_PY }, async () => {
  const d = dataset({ n: 60 });
  const ft = await freeTierRun(d, { verify: false });
  const env = ft.env;
  // August's pinned catalog, then the CC sheet grew by 262 rows and today's build pushed that catalog.
  const aug = bigCatalog();
  const today = bigCatalog();
  for (let i = MIN()['CC'] + 10, end = i + 262; i < end; i++) today.tables.vendor_costs['CC'][`CAL-X${i}`] = { unitCost: 3, product: `Synthetic plant ${i}`, size: '4in', note: null };
  today.tables.mcg_pack = { 'XQZZ5150-30': 30 };
  const base = await push(env, aug.tables);
  const latest = await push(env, today.tables);
  assert.equal(base.accepted && latest.accepted, true);
  // The correction: August's tables with only the MCG pack table added.
  const fix = { ...structuredClone(aug.tables), mcg_pack: { 'XQZZ5150-30': 30 } };
  // As an ordinary push (Oct 8, production): refused by the comparison with the newest catalog.
  const plain = await push(env, fix);
  assert.equal(plain.accepted, false);
  assert.match(plain.reasons.join(';'), /CC: \d+ SKUs, down from \d+ \(more than 10% decrease\)/);
  // As a correction of its base: accepted (the refused row is upgraded, its parts stored) and not the newest catalog.
  const pushAs = async (tables, correctionOf) => {
    const { layout, chunks } = chunk(tables);
    const opened = await ok(api(env, 'POST', '/v1/ingest/catalog/uploads', { layout, meta: { builtAt: 'x', commit: 'test', correctionOf } }, 'ingest'), 'open');
    for (const c of chunks) await ok(api(env, 'PUT', `/v1/ingest/catalog/uploads/${opened.uploadId}/chunks/${c.table}/${c.part}`, { entries: c.entries, ...(c.group !== null ? { group: c.group } : {}) }, 'ingest'), 'chunk');
    return api(env, 'POST', `/v1/ingest/catalog/uploads/${opened.uploadId}/seal`, {}, 'ingest');
  };
  const corr = await pushAs(fix, base.catalogRev);
  assert.deepEqual([corr.status, corr.json.accepted, corr.json.catalogRev], [200, true, plain.catalogRev], JSON.stringify(corr.json));
  const row = await env.DB.prepare('SELECT status, source, reject_reasons, meta FROM cost_catalog WHERE catalog_rev = ?1').bind(plain.catalogRev).first();
  assert.deepEqual([row.status, row.source, row.reject_reasons, JSON.parse(row.meta).correctionOf], ['accepted', 'correction_push', '[]', base.catalogRev]);
  assert.equal(stableStringify(catalogFromParts(plain.catalogRev, await storedParts(env, plain.catalogRev)).tables), stableStringify(fix));
  // New weeks keep today's catalog, also after another ordinary push of it and another correction push.
  const newest = () => env.DB.prepare(`SELECT catalog_rev FROM cost_catalog WHERE status = 'accepted' AND COALESCE(source, '') <> 'correction_push' ORDER BY COALESCE(last_pushed_at, captured_at) DESC, catalog_rev LIMIT 1`).first();
  assert.equal((await newest()).catalog_rev, latest.catalogRev);
  const fix2 = { ...structuredClone(aug.tables), mcg_pack: { 'XQZZ5150-30': 31 } };
  assert.equal((await pushAs(fix2, base.catalogRev)).json.accepted, true, 'a new correction catalog');
  assert.equal((await newest()).catalog_rev, latest.catalogRev);
  // An ordinary push is still compared with the newest catalog (correction catalogs never become the reference).
  assert.equal((await push(env, fix)).accepted, true, 'already accepted content is a duplicate');
  // A correction of an unknown or refused base is refused.
  assert.equal((await pushAs(fix, 'cat_0000000000000000')).json.error, 'correction_base_unknown');
  assert.equal((await api(env, 'POST', '/v1/ingest/catalog/uploads', { layout: chunk(fix).layout, meta: { correctionOf: 'nonsense' } }, 'ingest')).status, 400);
  // Registration accepts the correction catalog for a week on the base.
  await env.DB.prepare("INSERT INTO snapshot (snapshot_id, week_start, revision, status, computed_at, engine_version, policy, profitability_status, storage, catalog_rev) VALUES ('snp_c1', '2026-08-03', 9, 'published', 't', 'e', '{}', 'ok', 'chunked', ?1)").bind(base.catalogRev).run();
  const reg = await api(env, 'POST', '/v1/admin/cost-corrections', { reason: 'test: MCG pack costs corrected', weeks: [{ weekStart: '2026-08-03', fromCatalogRev: base.catalogRev, toCatalogRev: plain.catalogRev }] });
  assert.equal(reg.status, 200, JSON.stringify(reg.json));
});

test('vendor-name to vendor-code transition: content refused only for the keying is decided again and becomes the newest catalog', { skip: !HAVE_PY }, async () => {
  const { privateRules } = await import('../../shared/privateRules.js');
  const legend = privateRules().vendorLegend;
  const d = dataset({ n: 40 });
  const ft = await freeTierRun(d, { verify: false });
  const env = ft.env;
  const base = await push(env, bigCatalog().tables);
  assert.equal(base.accepted, true, JSON.stringify(base));
  // The pre-code catalog: its counts are stored by full vendor name.
  const codeCounts = JSON.parse((await env.DB.prepare('SELECT vendor_counts FROM cost_catalog WHERE catalog_rev = ?1').bind(base.catalogRev).first()).vendor_counts);
  const nameCounts = Object.fromEntries(Object.entries(codeCounts).map(([code, n]) => [legend[code] || code, n]));
  await env.DB.prepare('UPDATE cost_catalog SET vendor_counts = ?2 WHERE catalog_rev = ?1').bind(base.catalogRev, JSON.stringify(nameCounts)).run();
  // A newer build's catalog, refused earlier by the name-keyed comparison (every vendor read as 0); its parts were never stored.
  const today = bigCatalog();
  today.tables.mcg_total['MCG-NEW-1'] = 4.5;
  const first = await push(env, today.tables);
  const refusedReasons = Object.entries(nameCounts).filter(([v]) => v !== legend[v] && Object.values(legend).includes(v)).map(([v, n]) => `${v}: 0 SKUs, down from ${n} (more than 10% decrease)`);
  assert.ok(refusedReasons.length > 0, 'the fixture legend names at least one vendor');
  await env.DB.batch([
    env.DB.prepare("UPDATE cost_catalog SET status = 'rejected', reject_reasons = ?2, last_pushed_at = NULL, captured_at = '2026-01-01T00:00:00Z' WHERE catalog_rev = ?1").bind(first.catalogRev, JSON.stringify(refusedReasons)),
    env.DB.prepare('DELETE FROM cost_catalog_part WHERE catalog_rev = ?1').bind(first.catalogRev),
    env.DB.prepare("UPDATE cost_catalog SET last_pushed_at = '2026-01-02T00:00:00Z', captured_at = '2026-01-02T00:00:00Z' WHERE catalog_rev <> ?1 AND catalog_rev <> ?2").bind(base.catalogRev, first.catalogRev),
    env.DB.prepare('UPDATE cost_catalog SET last_pushed_at = ?2 WHERE catalog_rev = ?1').bind(base.catalogRev, new Date(Date.now() - 60_000).toISOString()),
  ]);
  const newest = async () => (await env.DB.prepare(`SELECT catalog_rev FROM cost_catalog WHERE status = 'accepted' AND COALESCE(source, '') <> 'correction_push' ORDER BY COALESCE(last_pushed_at, captured_at) DESC, catalog_rev LIMIT 1`).first()).catalog_rev;
  assert.equal(await newest(), base.catalogRev);
  // The same content pushed again: decided again, accepted, its parts stored, and the catalog new weeks use.
  const again = await push(env, today.tables);
  assert.deepEqual([again.catalogRev, again.accepted, again.activeCatalogRev], [first.catalogRev, true, first.catalogRev], JSON.stringify(again));
  const row = await env.DB.prepare('SELECT status, reject_reasons, vendor_counts, meta FROM cost_catalog WHERE catalog_rev = ?1').bind(first.catalogRev).first();
  assert.deepEqual([row.status, row.reject_reasons], ['accepted', '[]']);
  assert.deepEqual(Object.keys(JSON.parse(row.vendor_counts)).sort(), Object.keys(codeCounts).sort(), 'counts stored by code');
  assert.ok(JSON.parse(row.meta).rekeyedAt);
  assert.equal(stableStringify(catalogFromParts(first.catalogRev, await storedParts(env, first.catalogRev)).tables), stableStringify(today.tables));
  assert.equal(await newest(), first.catalogRev);
});

test('vendor-name to vendor-code transition: any other rejection stays refused', { skip: !HAVE_PY }, async () => {
  const { rejectedOnlyByVendorKeying } = await import('../../shared/catalog.js');
  const { privateRules } = await import('../../shared/privateRules.js');
  const [code, name] = Object.entries(privateRules().vendorLegend).find(([c, n]) => c !== n);
  assert.equal(rejectedOnlyByVendorKeying([`${name}: 0 SKUs, down from 50 (more than 10% decrease)`]), true);
  assert.equal(rejectedOnlyByVendorKeying([`${code}: 0 SKUs, down from 50 (more than 10% decrease)`]), false, 'a real shrink of a code-keyed vendor');
  assert.equal(rejectedOnlyByVendorKeying([`${name}: 0 SKUs, down from 50 (more than 10% decrease)`, 'required table mcg_total is empty or missing']), false);
  assert.equal(rejectedOnlyByVendorKeying([`Unknown Vendor: 0 SKUs, down from 50 (more than 10% decrease)`]), false);
  assert.equal(rejectedOnlyByVendorKeying([]), false);
  // End to end: content refused for a genuine reason is still refused when pushed again.
  const d = dataset({ n: 40 });
  const ft = await freeTierRun(d, { verify: false });
  const env = ft.env;
  assert.equal((await push(env, bigCatalog().tables)).accepted, true);
  const shrunk = bigCatalog({ drop: 'CC' });
  const r1 = await push(env, shrunk.tables);
  assert.equal(r1.accepted, false);
  const r2 = await push(env, shrunk.tables);
  assert.equal(r2.accepted, false, 'resubmitting refused content stays refused');
});
