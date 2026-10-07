/**
 * Audited cost corrections (migration 0022): each correction names explicit weeks with their original
 * catalog and its corrected copy (only the MCG pack table changed). Completion is judged by the applied
 * correction id and catalog revision, never by timestamps.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, catalog } from './helpers.mjs';
import { api } from './freeTierHarness.mjs';
import { correctedCatalog, CORRECTION_FOR_WEEK_SQL, CORRECTIONS_PENDING_SQL } from '../src/collectWeeks.js';

const corr = { correction_id: 'ccr_1', from_catalog_rev: 'cat_aug', to_catalog_rev: 'cat_augfix' };

test('correction: applied only while the week is on its original catalog; the id travels with the corrected catalog', () => {
  const on = rev => ({ rev, basis: 'published_snapshot', fromSnapshotId: 'snp_a' });
  assert.deepEqual(correctedCatalog(on('cat_aug'), { anchor: on('cat_aug'), correction: corr }),
    { rev: 'cat_augfix', basis: 'cost_restatement', correctionId: 'ccr_1', fromCatalogRev: 'cat_aug', fromSnapshotId: 'snp_a', refreshId: null });
  assert.deepEqual(correctedCatalog(on('cat_augfix'), { anchor: on('cat_augfix'), correction: corr }), { ...on('cat_augfix'), correctionId: 'ccr_1' });
  // A week on another catalog (e.g. a later week on a newer catalog) is never switched.
  assert.deepEqual(correctedCatalog(on('cat_oct'), { anchor: on('cat_oct'), correction: corr }), on('cat_oct'));
  // No snapshot, or no correction naming the week: the usual choice.
  const latest = { rev: 'cat_oct', basis: 'latest_accepted', refreshId: null };
  assert.equal(correctedCatalog(latest, { anchor: null, correction: corr }), latest);
  assert.equal(correctedCatalog(on('cat_aug'), { anchor: on('cat_aug'), correction: null }).rev, 'cat_aug');
});

async function seeded() {
  const env = await makeEnv();
  const snap = (id, w, rev, status, cat, info = null) => env.DB.prepare(`INSERT INTO snapshot (snapshot_id, week_start, revision, status, computed_at, engine_version, policy,
      profitability_status, storage, catalog_rev, catalog_info) VALUES (?1, ?2, ?3, ?4, '2026-10-06T00:00:00Z', 'e', '{}', 'ok', 'chunked', ?5, ?6)`)
    .bind(id, w, rev, status, cat, info ? JSON.stringify(info) : null).run();
  const corrRow = async (id, at, weeks) => {
    await env.DB.prepare("INSERT INTO cost_correction VALUES (?1, 'test reason', 'admin_secret', 't', ?2)").bind(id, at).run();
    for (const [w, from, to] of weeks) await env.DB.prepare('INSERT INTO cost_correction_week VALUES (?1, ?2, ?3, ?4)').bind(id, w, from, to).run();
  };
  return { env, snap, corrRow };
}

test('correction: a week is corrected only by id and catalog; an uncorrected revision computed after registration stays pending', async () => {
  const { env, snap, corrRow } = await seeded();
  await snap('snp_1', '2026-08-03', 4, 'published', 'cat_aug');
  await snap('snp_2', '2026-08-10', 3, 'published', 'cat_aug');
  await snap('snp_3', '2026-08-10', 4, 'draft', 'cat_augfix', { correctionId: 'ccr_1', basis: 'cost_restatement' });   // corrected draft
  await snap('snp_4', '2026-08-17', 3, 'published', 'cat_aug');
  // Registered first; this revision is computed LATER but on the original catalog: not corrected.
  await snap('snp_5', '2026-08-17', 4, 'draft', 'cat_aug');
  await snap('snp_6', '2026-09-28', 2, 'draft', 'cat_sep');
  await snap('snp_7', '2026-09-28', 3, 'draft', 'cat_sepfix', { correctionId: 'ccr_other' });                            // right catalog, wrong id
  await snap('snp_8', '2026-10-05', 1, 'draft', 'cat_oct');                                                              // a later week, not named
  await corrRow('ccr_1', '2026-10-01T00:00:00Z', [['2026-08-03', 'cat_aug', 'cat_augfix'], ['2026-08-10', 'cat_aug', 'cat_augfix'], ['2026-08-17', 'cat_aug', 'cat_augfix'],
                                                  ['2026-09-28', 'cat_sep', 'cat_sepfix']]);
  const pending = (await env.DB.prepare(CORRECTIONS_PENDING_SQL).bind('0000-00-00', 50).all()).results.map(r => r.week_start);
  // Aug 3: not yet corrected. Aug 10: newest is the corrected draft with this id → done. Aug 17: an uncorrected revision
  // computed after registration → still pending. Sep 28: the corrected catalog under another id is not this correction's
  // completion, and the published-or-newest catalog is cat_sepfix, not the original, so it is no longer applicable.
  assert.deepEqual(pending, ['2026-08-03', '2026-08-17']);
  // The week not named is never covered.
  assert.equal(await env.DB.prepare(CORRECTION_FOR_WEEK_SQL).bind('2026-10-05').first(), null);
  assert.equal((await env.DB.prepare(CORRECTION_FOR_WEEK_SQL).bind('2026-08-17').first()).to_catalog_rev, 'cat_augfix');
  // A newer correction for the same week takes over.
  await corrRow('ccr_2', '2026-10-02T00:00:00Z', [['2026-08-10', 'cat_augfix', 'cat_augfix2']]);
  assert.equal((await env.DB.prepare(CORRECTION_FOR_WEEK_SQL).bind('2026-08-10').first()).correction_id, 'ccr_2');
});

test('correction: registration names weeks on their original catalog and a copy that changes only the MCG table', async () => {
  const env = await makeEnv();
  const push = async c => (await api(env, 'POST', '/v1/ingest/catalog', c, 'ingest')).json.catalogRev;
  const base = catalog();
  const rev1 = await push(base);
  const fixed = catalog(); fixed.tables.mcg_pack = { 'RAKN1499-6': 12, 'RAKN1499-20': null };
  const rev2 = await push(fixed);
  const more = catalog(); more.tables.mcg_pack = { 'RAKN1499-6': 12 }; more.tables.hp_supplement = { ...more.tables.hp_supplement, 'MG-ALOE': 1 };
  const rev3 = await push(more);                                                      // also changes another table
  const same = catalog(); same.tables.sku_weights = { X: 1 };
  const rev4 = await push(same);                                                      // no MCG table
  await env.DB.prepare("INSERT INTO snapshot (snapshot_id, week_start, revision, status, computed_at, engine_version, policy, profitability_status, storage, catalog_rev) VALUES ('snp_a', '2026-08-03', 1, 'published', 't', 'e', '{}', 'ok', 'chunked', ?1)").bind(rev1).run();
  const reg = (weeks, reason = 'test: corrected MCG pack costs') => api(env, 'POST', '/v1/admin/cost-corrections', { reason, weeks });
  const wk = (weekStart, fromCatalogRev, toCatalogRev) => ({ weekStart, fromCatalogRev, toCatalogRev });
  assert.equal((await reg([wk('2026-08-03', rev1, rev2)], 'short')).status, 400);
  assert.equal((await reg([wk('2026-08-04', rev1, rev2)])).status, 400, 'a Monday');
  assert.equal((await reg([wk('2026-08-10', rev1, rev2)])).json.error, 'week_has_no_snapshot', 'a future week cannot be named');
  assert.equal((await reg([wk('2026-08-03', rev4, rev2)])).json.error, 'not_original_catalog');
  assert.equal((await reg([wk('2026-08-03', rev1, rev3)])).json.error, 'catalog_changes_more_than_mcg');
  assert.equal((await reg([wk('2026-08-03', rev1, rev4)])).json.error, 'no_mcg_table');
  const ok = await reg([wk('2026-08-03', rev1, rev2)]);
  assert.equal(ok.status, 200, ok.text);
  const listed = (await api(env, 'GET', '/v1/admin/cost-corrections')).json.corrections;
  assert.deepEqual(listed.map(c => [c.correction_id, c.actorClass, c.weeks]), [[ok.json.correctionId, 'admin_secret', [{ weekStart: '2026-08-03', fromCatalogRev: rev1, toCatalogRev: rev2 }]]]);
});
