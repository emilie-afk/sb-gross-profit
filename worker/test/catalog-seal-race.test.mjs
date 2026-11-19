/**
 * Catalog sealing vs concurrent chunk writes (reproduced on staging: a chunk replaced between the
 * seal's read and its commit gave HTTP 200, an accepted catalog, and stored parts whose hash did
 * not match the accepted revision). Now:
 *  - a seal freezes the upload before reading its chunks; chunk writes need 'open' in the write;
 *  - the commit re-checks the exact (table, part, sha256) set it validated, and every write in it
 *    is conditional on that check, so a mismatch stores nothing and fulfils no refresh;
 *  - failed seals reopen the upload; repeated seals replay the stored answer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, freeTierEnv } from './freeTierHarness.mjs';
import { catalogCandidate } from '../../tests/fixtures-free-tier.mjs';
import { catalogFromParts } from '../../shared/bundle.js';
import { catalogPartsRevOf } from '../../shared/catalog.js';
import { stableStringify } from '../../shared/normalized.js';
import { sha256Text } from '../src/gz.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HAVE_PY = spawnSync('python3', ['--version']).status === 0;
const chunk = tables => JSON.parse(execFileSync('python3', [path.join(REPO, 'catalog_push.py')], { input: JSON.stringify({ tables }), encoding: 'utf8', maxBuffer: 64 << 20 }));

function catalog(bump = 0) {
  const c = catalogCandidate();
  for (let i = 0; i < 900; i++) c.tables.mcg_total[`MCG-${String(i).padStart(5, '0')}`] = Math.round(i * 37.3 + bump) / 100 + 1;   // ≥ 2 chunks
  return c.tables;
}
const crf = () => 'crf_' + [...crypto.getRandomValues(new Uint8Array(10))].map(b => b.toString(16).padStart(2, '0')).join('');
async function pendingRefresh(env) {
  const id = crf();
  await env.DB.prepare("INSERT INTO catalog_refresh (refresh_id, week_start, requested_at, requested_by_class, status) VALUES (?1, '2026-09-21', ?2, 'test', 'pending')")
    .bind(id, new Date().toISOString()).run();
  return id;
}
async function upload(env, tables, { refreshId = null, skip = () => false } = {}) {
  const { layout, chunks } = chunk(tables);
  const o = await api(env, 'POST', '/v1/ingest/catalog/uploads', { layout, meta: { builtAt: '2026-10-01T00:00:00Z', commit: 'test', ...(refreshId ? { refreshId } : {}) } }, 'ingest');
  assert.equal(o.status, 200, JSON.stringify(o.json));
  for (const c of chunks) if (!skip(c)) assert.equal((await putChunk(env, o.json.uploadId, c)).status, 200);
  return { id: o.json.uploadId, chunks };
}
const putChunk = (env, id, c, entries = c.entries) => api(env, 'PUT', `/v1/ingest/catalog/uploads/${id}/chunks/${c.table}/${c.part}`, { entries, ...(c.group !== null ? { group: c.group } : {}) }, 'ingest');
const seal = (env, id) => api(env, 'POST', `/v1/ingest/catalog/uploads/${id}/seal`, {}, 'ingest');
/** Run `fn` once, right after (or before) the first batch whose first statement matches `re`. */
function hookBatch(env, re, fn, { before = false } = {}) {
  const real = env.DB.batch.bind(env.DB);
  let done = false;
  env.DB.batch = async stmts => {
    const hit = !done && re.test(stmts[0]?.sql || '');
    if (hit) done = true;
    if (hit && before) await fn();
    const out = await real(stmts);
    if (hit && !before) await fn();
    return out;
  };
  return () => { env.DB.batch = real; };
}
const FREEZE = /SET status = 'sealing'/, COMMIT = /SET status = 'sealed'/;
const one = async (env, sql, ...b) => env.DB.prepare(sql).bind(...b).first();
const count = async (env, sql, ...b) => (await one(env, sql, ...b)).n;
const parts = async (env, rev) => ((await env.DB.prepare('SELECT table_name, part, payload FROM cost_catalog_part WHERE catalog_rev = ?1').bind(rev).all()).results || []).map(r => [r.table_name, r.part, r.payload]);
/** Every accepted chunked catalog: its revision is the hash of exactly its stored parts. */
async function everyAcceptedRevMatchesItsParts(env) {
  const revs = (await env.DB.prepare("SELECT catalog_rev FROM cost_catalog WHERE status = 'accepted' AND source = 'build_push_chunked'").all()).results.map(r => r.catalog_rev);
  for (const rev of revs) assert.equal(await catalogPartsRevOf(await parts(env, rev)), rev, `accepted ${rev} matches its stored parts`);
  return revs.length;
}

test('seal race: a chunk replaced through the API while a seal runs is refused; the accepted catalog is the validated one', { skip: !HAVE_PY }, async () => {
  const env = await freeTierEnv(), tables = catalog();
  const { id, chunks } = await upload(env, tables);
  const target = chunks.find(c => c.table === 'mcg_total' && c.part === 1);
  let during;
  const restore = hookBatch(env, FREEZE, async () => { during = await putChunk(env, id, target, Object.fromEntries(Object.entries(target.entries).map(([k, v]) => [k, v + 1]))); });
  const s = await seal(env, id);
  restore();
  assert.deepEqual([during.status, during.json.error], [409, 'upload_closed'], 'a chunk write during sealing is refused');
  assert.equal(s.status, 200); assert.equal(s.json.accepted, true);
  assert.equal(stableStringify(catalogFromParts(s.json.catalogRev, await parts(env, s.json.catalogRev)).tables), stableStringify(tables), 'the stored catalog is the one validated');
  assert.equal(await everyAcceptedRevMatchesItsParts(env), 1);
  assert.equal((await putChunk(env, id, target)).status, 409, 'a sealed upload takes no chunks');
});

test('seal race: chunks that change between validation and commit store nothing and fulfil no refresh; a new seal stores a consistent catalog', { skip: !HAVE_PY }, async () => {
  const env = await freeTierEnv(), tables = catalog();
  const refreshId = await pendingRefresh(env);
  const { id } = await upload(env, tables, { refreshId });
  // Below the API (which can no longer do it): rewrite one stored chunk just before the commit.
  const restore = hookBatch(env, COMMIT, async () => {
    const p = await one(env, "SELECT payload FROM catalog_upload_part WHERE upload_id = ?1 AND table_name = 'mcg_total' AND part = 1", id);
    const changed = p.payload.replace(/:(\d+(\.\d+)?)/, (m, n) => `:${Number(n) + 5}`);
    assert.notEqual(changed, p.payload);
    await env.DB.prepare("UPDATE catalog_upload_part SET payload = ?2, sha256 = ?3 WHERE upload_id = ?1 AND table_name = 'mcg_total' AND part = 1").bind(id, changed, await sha256Text(changed)).run();
  }, { before: true });
  const s = await seal(env, id);
  restore();
  assert.deepEqual([s.status, s.json.error], [409, 'seal_conflict']);
  assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM cost_catalog'), 0, 'no catalog row');
  assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM cost_catalog_part'), 0, 'no parts');
  assert.equal(await count(env, "SELECT COUNT(*) AS n FROM ingest_run WHERE source = 'catalog'"), 0, 'no ingest record');
  assert.equal((await one(env, 'SELECT status FROM catalog_refresh WHERE refresh_id = ?1', refreshId)).status, 'pending', 'the refresh is not fulfilled');
  assert.equal((await one(env, 'SELECT status FROM catalog_upload WHERE upload_id = ?1', id)).status, 'open', 'the upload is open again');
  // Sealing again validates what is stored now; the accepted revision is exactly its parts.
  const again = await seal(env, id);
  assert.equal(again.status, 200); assert.equal(again.json.accepted, true);
  assert.equal(await everyAcceptedRevMatchesItsParts(env), 1);
  const r = await one(env, 'SELECT status, catalog_rev FROM catalog_refresh WHERE refresh_id = ?1', refreshId);
  assert.deepEqual([r.status, r.catalog_rev, again.json.refresh.status], ['fulfilled', again.json.catalogRev, 'fulfilled']);
});

test('seal recovery: missing chunks, a failed commit, a lost answer and a dead sealer all recover safely', { skip: !HAVE_PY }, async () => {
  const env = await freeTierEnv(), tables = catalog();
  const refreshId = await pendingRefresh(env);
  // Interrupted upload: a chunk missing → refused, upload stays open; upload it and seal.
  const { id, chunks } = await upload(env, tables, { refreshId, skip: c => c.table === 'sku_weights' });
  assert.deepEqual([(await seal(env, id)).json.error], ['chunks_missing']);
  for (const c of chunks.filter(c => c.table === 'sku_weights')) assert.equal((await putChunk(env, id, c)).status, 200, 'chunks are accepted again');
  // The commit fails (D1 error): nothing stored, refresh pending, upload open.
  env.DB.failNextBatchAt(COMMIT);
  assert.ok((await seal(env, id)).status >= 500);
  assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM cost_catalog'), 0);
  assert.equal((await one(env, 'SELECT status FROM catalog_refresh WHERE refresh_id = ?1', refreshId)).status, 'pending');
  assert.equal((await one(env, 'SELECT status FROM catalog_upload WHERE upload_id = ?1', id)).status, 'open');
  // Retry: stored; then the answer is "lost" and the seal repeated → the same answer, replayed, no new rows.
  const s = await seal(env, id);
  assert.equal(s.json.accepted, true);
  const rep = await seal(env, id);
  assert.equal(rep.status, 200);
  assert.equal(rep.json.replayed, true);
  const strip = a => { const { replayed, ...x } = a; return x; };
  assert.deepEqual(strip(rep.json), s.json);
  assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM cost_catalog'), 1);
  assert.equal(await count(env, "SELECT COUNT(*) AS n FROM ingest_run WHERE source = 'catalog'"), 1);
  assert.equal(stableStringify(catalogFromParts(s.json.catalogRev, await parts(env, s.json.catalogRev)).tables), stableStringify(tables));
  // A sealer that died after freezing: refused while fresh, taken over once stale.
  const b = await upload(env, catalog(1));
  await env.DB.prepare("UPDATE catalog_upload SET status = 'sealing', seal_token = 'seal_dead', sealing_at = ?2 WHERE upload_id = ?1").bind(b.id, new Date().toISOString()).run();
  assert.deepEqual([(await seal(env, b.id)).json.error], ['seal_in_progress']);
  await env.DB.prepare("UPDATE catalog_upload SET sealing_at = ?2 WHERE upload_id = ?1").bind(b.id, new Date(Date.now() - 120_000).toISOString()).run();
  const t = await seal(env, b.id);
  assert.equal(t.status, 200); assert.equal(t.json.accepted, true);
  assert.equal(await everyAcceptedRevMatchesItsParts(env), 2);
});

test('seal concurrency: duplicate and concurrent seals give one catalog, one ingest record and one refresh resolution', { skip: !HAVE_PY }, async () => {
  const env = await freeTierEnv(), tables = catalog();
  const refreshId = await pendingRefresh(env);
  const { id } = await upload(env, tables, { refreshId });
  const all = await Promise.all([seal(env, id), seal(env, id), seal(env, id)]);
  const okd = all.filter(r => r.status === 200), fresh = okd.filter(r => !r.json.replayed);
  assert.equal(fresh.length, 1, JSON.stringify(all.map(r => [r.status, r.json.error, r.json.replayed])));
  for (const r of all) assert.ok(r.status === 200 || r.json.error === 'seal_in_progress', JSON.stringify(r.json));
  for (const r of okd) assert.equal(r.json.catalogRev, fresh[0].json.catalogRev);
  assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM cost_catalog'), 1);
  assert.equal(await count(env, "SELECT COUNT(*) AS n FROM ingest_run WHERE source = 'catalog'"), 1);
  assert.equal((await one(env, 'SELECT status FROM catalog_refresh WHERE refresh_id = ?1', refreshId)).status, 'fulfilled');
  // Take-over race: seal A freezes and stalls past the stale limit; seal B takes over and commits;
  // A's commit then finds the upload sealed by B → A writes nothing and replays B's answer.
  const env2 = await freeTierEnv(), r2 = await pendingRefresh(env2);
  const u2 = await upload(env2, tables, { refreshId: r2 });
  let bAnswer;
  const restore = hookBatch(env2, COMMIT, async () => {
    restore();
    await env2.DB.prepare("UPDATE catalog_upload SET sealing_at = ?2 WHERE upload_id = ?1").bind(u2.id, new Date(Date.now() - 120_000).toISOString()).run();
    bAnswer = await seal(env2, u2.id);
  }, { before: true });
  const a = await seal(env2, u2.id);
  assert.equal(bAnswer.status, 200); assert.equal(bAnswer.json.replayed, undefined);
  assert.deepEqual([a.status, a.json.replayed, a.json.catalogRev], [200, true, bAnswer.json.catalogRev]);
  assert.equal(await count(env2, 'SELECT COUNT(*) AS n FROM cost_catalog'), 1);
  assert.equal(await count(env2, "SELECT COUNT(*) AS n FROM ingest_run WHERE source = 'catalog'"), 1);
  assert.equal(await everyAcceptedRevMatchesItsParts(env2), 1);
  assert.equal((await one(env2, 'SELECT status FROM catalog_refresh WHERE refresh_id = ?1', r2)).status, 'fulfilled');
});

test('seal: a rejected catalog rejects (never fulfils) its refresh and stores no parts', { skip: !HAVE_PY }, async () => {
  const env = await freeTierEnv();
  const first = await upload(env, catalog());
  assert.equal((await seal(env, first.id)).json.accepted, true);
  const shrunk = catalog(); for (const k of Object.keys(shrunk.mcg_total).slice(0, 800)) delete shrunk.mcg_total[k];
  const refreshId = await pendingRefresh(env);
  const { id } = await upload(env, shrunk, { refreshId });
  const s = await seal(env, id);
  assert.equal(s.json.accepted, false, JSON.stringify(s.json));
  assert.equal(s.json.refresh.status, 'rejected');
  assert.equal((await one(env, 'SELECT status FROM catalog_refresh WHERE refresh_id = ?1', refreshId)).status, 'rejected');
  assert.equal(await count(env, 'SELECT COUNT(*) AS n FROM cost_catalog_part WHERE catalog_rev = ?1', s.json.catalogRev), 0);
  assert.equal(s.json.activeCatalogRev, (await seal(env, first.id)).json.catalogRev, 'the previous catalog stays active');
});
