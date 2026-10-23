/**
 * Custom-date reports, "Include provisional data": GET /v1/weeks?provisional=1 and the snapshot routes with
 * ?provisional=1 serve, for a week with NO published revision, its latest independently VERIFIED revision,
 * marked provisional with the checks that hold it. Read only: no write, no publication, gates unchanged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import worker from '../src/index.js';
import { dataset, freeTierRun, changes } from './freeTierHarness.mjs';

const ORIGIN = 'https://worker.test';
const read = async (env, path, cls = 'reader') => {
  const h = { 'CF-Connecting-IP': '203.0.113.9' };
  if (cls === 'reader') { h['X-Dashboard-Reader-Secret'] = env.DASHBOARD_READER_SECRET; h['X-Gate-Session'] = `gat_${'0'.repeat(32)}`; } else h['X-Admin-Secret'] = env.ADMIN_SECRET;
  const r = await worker.fetch(new Request(ORIGIN + path, { headers: h }), env);
  return { status: r.status, json: await r.json().catch(() => null) };
};
/** A copy of a week's newest snapshot as a newer revision (rows and parts shared by reference), with a verification status. */
function newerRevision(env, w, { status = 'draft', verification = 'verified' } = {}) {
  const db = env.DB.db, s = db.prepare('SELECT * FROM snapshot WHERE week_start = ? ORDER BY revision DESC LIMIT 1').get(w);
  const id = `snp_${crypto.randomBytes(10).toString('hex')}`;
  const cols = Object.keys(s).filter(c => !['snapshot_id', 'revision', 'status', 'published_at', 'superseded_by'].includes(c));
  db.prepare(`INSERT INTO snapshot (snapshot_id, revision, status, ${cols.join(', ')}) SELECT ?, ?, ?, ${cols.join(', ')} FROM snapshot WHERE snapshot_id = ?`).run(id, s.revision + 1, status, s.snapshot_id);
  for (const t of ['snapshot_totals', 'snapshot_blob']) {
    const tc = db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all().map(r => r.name).filter(c => c !== 'snapshot_id');
    db.prepare(`INSERT INTO ${t} (snapshot_id, ${tc.join(', ')}) SELECT ?, ${tc.join(', ')} FROM ${t} WHERE snapshot_id = ?`).run(id, s.snapshot_id);
  }
  if (verification) {
    const vc = db.prepare("SELECT name FROM pragma_table_info('verify_report')").all().map(r => r.name).filter(c => !['snapshot_id', 'status'].includes(c));
    db.prepare(`INSERT INTO verify_report (snapshot_id, status, ${vc.join(', ')}) SELECT ?, ?, ${vc.join(', ')} FROM verify_report WHERE snapshot_id = ?`).run(id, verification, s.snapshot_id);
  }
  return { id, revision: s.revision + 1 };
}

let env, weeks, before, held, pub, early;
test('setup: verified weeks; some published, the newest held', { timeout: 300_000 }, async () => {
  const d = dataset({ n: 200 });
  ({ env } = await freeTierRun(d, { verify: true }));
  env.DASHBOARD_READER_SECRET = 'r'.repeat(40);
  weeks = d.weeks; early = weeks[0]; pub = weeks[1]; held = weeks.at(-1);
  env.PUBLICATION_EARLIEST_WEEK = pub;
  const db = env.DB.db;
  for (const w of weeks.slice(1, -1)) db.prepare("UPDATE snapshot SET status = 'published', published_at = computed_at WHERE week_start = ? AND revision = (SELECT MAX(revision) FROM snapshot WHERE week_start = ?)").run(w, w);
  for (const w of [early, held]) assert.equal(db.prepare("SELECT COUNT(*) AS n FROM snapshot WHERE week_start = ? AND status = 'published'").get(w).n, 0, `${w} unpublished`);
  assert.equal(db.prepare("SELECT v.status FROM snapshot s JOIN verify_report v ON v.snapshot_id = s.snapshot_id WHERE s.week_start = ? ORDER BY s.revision DESC LIMIT 1").get(held).status, 'verified');
  newerRevision(env, pub);                                    // a published week with a newer verified draft
  newerRevision(env, held, { verification: 'pending' });      // the held week's newest revision is not verified yet
  before = { changes: changes(env), statuses: db.prepare('SELECT snapshot_id, status, published_at FROM snapshot ORDER BY snapshot_id').all() };
});

test('default: published only; the held week is not readable', async () => {
  const l = (await read(env, '/v1/weeks')).json.weeks;
  assert.ok(!l.some(w => w.weekStart === held) && !l.some(w => w.revisions.some(r => r.provisional)));
  assert.equal((await read(env, `/v1/snapshot/${held}`)).json.error, 'not_published');
  assert.equal((await read(env, `/v1/snapshot/${held}?includeDrafts=1`)).status, 404, 'includeDrafts is admin only');
});

test('provisional=1: the latest VERIFIED revision of unpublished weeks only, with its holds; published weeks stay at their published revision', async () => {
  const l = (await read(env, '/v1/weeks?provisional=1')).json.weeks;
  const h = l.find(w => w.weekStart === held);
  assert.equal(h.revisions.length, 1);
  const r = h.revisions[0];
  const verifiedRev = env.DB.db.prepare("SELECT MAX(s.revision) AS r FROM snapshot s JOIN verify_report v ON v.snapshot_id = s.snapshot_id WHERE s.week_start = ? AND v.status = 'verified'").get(held).r;
  assert.deepEqual([r.provisional, r.revision, r.verification], [true, verifiedRev, 'verified'], 'the unverified newer revision is skipped');
  assert.ok(Array.isArray(r.hold) && r.hold.length > 0 && r.hold.every(x => x.code && x.message), JSON.stringify(r.hold));
  assert.ok(r.shippingCoverage && typeof r.missingCostLines === 'number');
  const p = l.find(w => w.weekStart === pub);
  assert.deepEqual(p.revisions.map(x => [x.status, !!x.provisional]), [['published', false]], 'never both a published and an unpublished revision');
  assert.ok(!l.some(w => w.weekStart === early), 'nothing before the publication start');
  // Snapshot, parts and orders at that revision; the published week at its published revision.
  const s = (await read(env, `/v1/snapshot/${held}?provisional=1`)).json;
  assert.deepEqual([s.revision, s.provisional, s.verification.status], [verifiedRev, true, 'verified']);
  assert.deepEqual(s.hold, r.hold);
  const part = await read(env, `/v1/snapshot/${held}/report-part/0?provisional=1&snapshot=${s.snapshotId}`);
  assert.equal(part.status, 200);
  assert.ok(part.json.o.orders.length > 0);
  assert.equal((await read(env, `/v1/snapshot/${held}/orders?provisional=1&limit=5`)).status, 200);
  const sp = (await read(env, `/v1/snapshot/${pub}?provisional=1`)).json;
  assert.deepEqual([sp.status, sp.provisional], ['published', undefined]);
  assert.equal((await read(env, `/v1/snapshot/${early}?provisional=1`)).json.error, 'not_published', 'before the publication start: never');
});

test('reading provisional data writes nothing and publishes nothing', async () => {
  for (let i = 0; i < 3; i++) { await read(env, '/v1/weeks?provisional=1'); await read(env, `/v1/snapshot/${held}?provisional=1`); }
  const db = env.DB.db;
  assert.equal(changes(env), before.changes, 'no rows written by provisional reads');
  assert.deepEqual(db.prepare('SELECT snapshot_id, status, published_at FROM snapshot ORDER BY snapshot_id').all(), before.statuses);
  // The held week stays unpublished for every reader.
  assert.equal((await read(env, `/v1/snapshot/${held}`)).json.error, 'not_published');
});
