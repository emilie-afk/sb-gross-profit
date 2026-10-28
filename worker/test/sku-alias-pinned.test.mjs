/**
 * A new catalog with SKU aliases changes no published week: the week keeps its pinned catalog when it is recomputed,
 * its published revision and totals stay as they are, and the new catalog is only what weeks without a pinned
 * catalog would pick up. Synthetic data only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { api, ok, dataset, freeTierRun, runVerifier } from './freeTierHarness.mjs';
import * as FT from '../../automation/collector/src/freeTier.mjs';

test('aliases: a published week keeps its pinned catalog and totals after a catalog with aliases is pushed', async () => {
  const d = dataset({ n: 80 });
  const { env, c } = await freeTierRun(d);
  const w = d.weeks[1];
  const pinned = (await env.DB.prepare('SELECT catalog_rev FROM snapshot WHERE week_start = ?1 ORDER BY revision DESC LIMIT 1').bind(w).first()).catalog_rev;
  await ok(api(env, 'POST', `/v1/admin/weeks/${w}/accept-pinned-catalog`, { catalogRev: pinned, reason: 'test: pinned catalog is right for this period' }), 'accept pinned');
  for (const [k, v] of [['provisional_publication_enabled', true], ['publication_enabled', true], ['ss_coverage_threshold', 0.85]]) await ok(api(env, 'POST', '/v1/admin/settings', { [k]: v, reason: `test: approved ${k}` }), k);
  env.PUBLICATION_ALLOWED = 'true'; env.PUBLICATION_EARLIEST_WEEK = w;
  const cache = FT.newCache();
  const compute = async () => { const r = await FT.computeAndUploadWeek(c, w, cache); assert.equal(r.status, 'computed', JSON.stringify(r)); assert.equal((await runVerifier(env, r.snapshotId)).body.status, 'verified'); return r; };
  await compute();
  assert.equal((await c.call('POST', `/v1/collect/weeks/${w}/publish`, { json: {} })).published, true);
  const published = async () => env.DB.prepare(`SELECT s.snapshot_id, s.revision, s.catalog_rev, s.status, t.* FROM snapshot s JOIN snapshot_totals t ON t.snapshot_id = s.snapshot_id
      WHERE s.week_start = ?1 AND s.status = 'published'`).bind(w).first();
  const before = await published();
  assert.equal(before.catalog_rev, pinned);

  // A new catalog: the same costs plus alias rows (one pointing a week's SKU elsewhere, so any use would show).
  const sku = Object.keys(d.catalog.tables.mcg_total)[0];
  const next = structuredClone(d.catalog);
  next.tables.sku_alias = { 'AMZ-SYNTH-1': sku, [sku]: sku, '9001-2P': `${sku}+EEZZ7620.BR-1` };
  next.meta = { ...(next.meta || {}), builtAt: '2026-10-29T00:00:00Z', commit: 'alias-test' };
  const pushed = await ok(api(env, 'POST', '/v1/ingest/catalog', next, 'ingest'), 'new catalog');
  assert.equal(pushed.accepted, true);
  assert.notEqual(pushed.catalogRev, pinned, 'a different catalog');

  // The collector's next pass leaves the published week as it is: its inputs (pinned catalog included) did not change.
  const again = await FT.computeAndUploadWeek(c, w, FT.newCache());
  assert.deepEqual([again.status, again.snapshotId, again.snapshotStatus], ['unchanged', before.snapshot_id, 'published'], JSON.stringify(again));
  assert.deepEqual(await published(), before, 'the published revision, its pinned catalog and its totals are untouched');
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM snapshot WHERE week_start = ?1 AND catalog_rev = ?2').bind(w, pushed.catalogRev).first()).n, 0, 'no revision of the week uses the new catalog');
  // Weeks with nothing pinned are what a new catalog serves: the latest accepted catalog is now the alias one.
  const latest = await env.DB.prepare("SELECT catalog_rev FROM cost_catalog WHERE status = 'accepted' AND COALESCE(source, '') <> 'correction_push' ORDER BY COALESCE(last_pushed_at, captured_at) DESC LIMIT 1").first();
  assert.equal(latest.catalog_rev, pushed.catalogRev);
});
