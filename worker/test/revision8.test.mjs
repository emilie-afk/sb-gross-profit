/**
 * Revision 8: the scheduled snapshot and the run's final state are ONE
 * claim-guarded transaction. Adversarial tests on the D1 stand-in, using the
 * Worker's test-only hook points (schedule:before_final_txn,
 * schedule:after_final_txn). The same scenarios run on real D1 in
 * worker/test/workerd-adversarial.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { WEEK, ingest, admin, loaded, viaNormalized } from './helpers.mjs';

const RUN_TABLES = ['reporting_run', 'run_transition', 'snapshot', 'snapshot_totals', 'snapshot_order'];
const STALE_MS = 150;                                      // test-only stale limit (TEST_STALE_MS)
const stall = () => new Promise(r => setTimeout(r, STALE_MS + 60));  // the owner stalls past it: time passes, the run is untouched
const one = (env, sql, ...p) => env.DB.prepare(sql).bind(...p).first();
const all = async (env, sql, ...p) => (await env.DB.prepare(sql).bind(...p).all()).results;
const schedule = (env, label = 'ops:S4') => admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK, trigger: 'schedule', actorLabel: label });

/** A week ready for its scheduled run, with test hooks routed to `on(point, data)`. */
async function ready(on) {
  const { env } = await loaded(20, { TEST_HOOKS_ENABLED: 'true', TEST_STALE_MS: String(STALE_MS) });
  await ingest(env, '/v1/ingest/shopify', viaNormalized({ mode: 'updated_since', nodes: [], weekStart: WEEK }));
  env.TEST_HOOK = { fetch: async (url, init) => { await on(new URL(url).pathname.slice(1), JSON.parse(init.body), env); return new Response('ok'); } };
  return env;
}
/** Everything a losing owner could touch. */
async function digest(env, tables = ['reporting_run', 'run_transition', 'snapshot', 'snapshot_totals', 'snapshot_order', 'schedule_cycle']) {
  const t = {};
  for (const table of tables) {
    t[table] = await all(env, `SELECT * FROM ${table} ORDER BY 1, 2`);
  }
  return JSON.stringify(t);
}
async function consistent(env) {
  const runs = await all(env, "SELECT * FROM reporting_run WHERE trigger = 'schedule'");
  const snaps = await all(env, 'SELECT snapshot_id, run_id FROM snapshot');
  const tr = await all(env, 'SELECT seq, to_state FROM run_transition WHERE run_id = ?1 ORDER BY seq', runs[0]?.run_id);
  return {
    cycles: (await one(env, 'SELECT COUNT(*) AS n FROM schedule_cycle')).n, runs: runs.length, snapshots: snaps.length,
    orphanSnapshots: snaps.filter(s => s.snapshot_id !== runs[0]?.snapshot_id).length,
    contiguousSeq: tr.every((t, i) => t.seq === i), state: runs[0]?.state, transitions: tr.map(t => t.to_state),
  };
}

test('hooks are test-only: no configuration binds them', () => {
  const toml = fs.readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.ok(!/TEST_HOOK/.test(toml));
});

test('hooks are inert unless TEST_HOOKS_ENABLED is "true"', async () => {
  const { env } = await loaded(20);
  await ingest(env, '/v1/ingest/shopify', viaNormalized({ mode: 'updated_since', nodes: [], weekStart: WEEK }));
  let called = 0;
  env.TEST_HOOK = { fetch: async () => { called++; return new Response('ok'); } };
  assert.equal((await schedule(env)).status, 200);
  assert.equal(called, 0);
});

test('A: the claim changes before the snapshot transaction → the old owner writes nothing', async () => {
  let atLoss;
  const env = await ready(async (point, _d, env) => {
    if (point !== 'schedule:before_final_txn') return;
    await env.DB.prepare("UPDATE schedule_cycle SET claim_token = 'clm_someone_else'").run();
    atLoss = await digest(env);
  });
  const r = await schedule(env);
  assert.deepEqual([r.status, r.json.error], [409, 'ownership_lost']);
  assert.equal(await digest(env), atLoss, 'nothing changed after the claim was lost');
  assert.equal((await one(env, 'SELECT COUNT(*) AS n FROM snapshot')).n, 0);
  assert.equal((await one(env, "SELECT state FROM reporting_run WHERE trigger = 'schedule'")).state, 'computing');
});

test('B: the claim changes right after the transaction → the snapshot and final run state were committed together; no later write', async () => {
  let atLoss;
  const env = await ready(async (point, _d, env) => {
    if (point !== 'schedule:after_final_txn') return;
    const c = await consistent(env);
    assert.deepEqual([c.snapshots, c.orphanSnapshots, c.state], [1, 0, 'validated']);   // already complete at commit
    await env.DB.prepare("UPDATE schedule_cycle SET claim_token = 'clm_someone_else'").run();
    atLoss = await digest(env);
  });
  const r = await schedule(env);
  assert.equal(r.status, 200);
  assert.equal(await digest(env), atLoss, 'the old owner wrote nothing after losing the claim');
});

test('B/C: the gap cannot exist — a failure anywhere in the final transaction commits nothing, not even the draft step', async () => {
  for (const at of [/UPDATE reporting_run SET state = \?2, snapshot_id/, /INSERT INTO run_transition/, /INSERT INTO snapshot_totals/]) {
    const env = await ready(async (point, _d, env) => {
      if (point !== 'schedule:before_final_txn') return;
      env.DB.failNextBatchAt(at);
    });
    const r = await schedule(env);
    assert.equal(r.status, 500, String(at));
    const run = await one(env, "SELECT state FROM reporting_run WHERE trigger = 'schedule'");
    const snaps = (await one(env, 'SELECT COUNT(*) AS n FROM snapshot')).n;
    const drafts = (await one(env, "SELECT COUNT(*) AS n FROM run_transition WHERE to_state = 'draft'")).n;
    assert.deepEqual([snaps, drafts], [0, 0], String(at));
    assert.equal(run.state, 'failed', String(at));                                    // the owner (still owning) marks it failed
  }
});

test('C: draft and validated are recorded in the same commit — never observable apart', async () => {
  const seen = [];
  const env = await ready(async (point, _d, env) => {
    seen.push([point, (await one(env, "SELECT state FROM reporting_run WHERE trigger = 'schedule'")).state,
               (await all(env, "SELECT to_state FROM run_transition WHERE to_state IN ('draft','validated','blocked')")).length]);
  });
  await schedule(env);
  assert.deepEqual(seen, [['schedule:before_final_txn', 'computing', 0], ['schedule:after_final_txn', 'validated', 2]]);
  const tr = await all(env, "SELECT seq, to_state, at FROM run_transition WHERE to_state IN ('draft','validated') ORDER BY seq");
  assert.equal(tr[1].seq, tr[0].seq + 1);
  assert.equal(tr[0].at, tr[1].at);
});

test('D: the old owner resumes after a new owner completed → one cycle, one run, one snapshot, nothing changed by the loser', async () => {
  let firstToken = null, afterWinner, winner;
  const env = await ready(async (point, d, env) => {
    if (point !== 'schedule:before_final_txn' || firstToken) return;
    firstToken = d.token;
    // The original owner stalls past the stale limit; a new owner takes over and finishes.
    await stall();
    winner = await schedule(env, 'ops:S4-new-owner');
    afterWinner = await digest(env);
  });
  const loser = await schedule(env, 'ops:S4-old-owner');
  assert.deepEqual([winner.status, winner.json.resumed, winner.json.state], [200, true, 'validated']);
  assert.deepEqual([loser.status, loser.json.error], [409, 'ownership_lost']);
  assert.equal(await digest(env), afterWinner, 'the losing owner changed nothing');
  const c = await consistent(env);
  assert.deepEqual([c.cycles, c.runs, c.snapshots, c.orphanSnapshots, c.contiguousSeq, c.state], [1, 1, 1, 0, true, 'validated']);
  const again = await schedule(env, 'ops:S4-old-owner-retry');
  assert.deepEqual([again.json.existing, again.json.runId], [true, winner.json.runId]);
});

test('E: a takeover racing the commit → exactly one owner completes and D1 stays consistent', async () => {
  for (const variant of ['owner_commits_first', 'takeover_claims_first']) {
    let first = null, racer;
    const env = await ready(async (point, d, env) => {
      if (point !== 'schedule:before_final_txn' || first) return;
      first = d.token;
      await stall();
      racer = schedule(env, 'ops:S4-racer');                      // not awaited: races the commit
      if (variant === 'takeover_claims_first') {
        for (let i = 0; i < 200; i++) {                            // let the takeover reach its claim first
          if ((await one(env, 'SELECT claim_token FROM schedule_cycle')).claim_token !== d.token) break;
          await new Promise(r => setImmediate(r));
        }
      }
    });
    const original = await schedule(env, 'ops:S4-original');
    const other = await racer;
    const completed = [original, other].filter(r => r.status === 200 && !r.json.existing);
    assert.equal(completed.length, 1, `${variant}: ${JSON.stringify([original.json, other.json])}`);
    assert.ok([original, other].every(r => r.status === 200 || r.json.error === 'ownership_lost'), variant);
    const c = await consistent(env);
    assert.deepEqual([c.cycles, c.runs, c.snapshots, c.orphanSnapshots, c.contiguousSeq, c.state], [1, 1, 1, 0, true, 'validated'], variant);
    assert.equal(completed[0] === original, variant === 'owner_commits_first', `${variant}: expected winner`);
  }
});

test('manual (non-scheduled) computes keep the two-step guarded transitions', async () => {
  const { env } = await loaded(20);
  const r = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  const tr = await all(env, 'SELECT to_state, at FROM run_transition WHERE run_id = ?1 ORDER BY seq', r.json.runId);
  assert.deepEqual(tr.map(t => t.to_state), ['created', 'computing', 'draft', 'validated']);
});

test('an admin recompute of a scheduled run is refused while it is being computed, and otherwise takes the claim first', async () => {
  // Live owner, not stale: the admin recompute is refused and the owner completes.
  let refused, entered1 = false;
  const env = await ready(async (point, d, env) => {
    if (point !== 'schedule:before_final_txn' || entered1) return;
    entered1 = true;
    refused = await admin(env, 'POST', `/v1/admin/runs/${d.runId}/compute`, { reason: 'operator recompute (test)' });
  });
  const owner = await schedule(env);
  assert.deepEqual([refused.status, refused.json.error], [409, 'scheduled_run_in_progress']);
  assert.equal(owner.status, 200);

  // Stalled owner: the admin recompute takes the claim; the owner then writes nothing.
  let adminRun, afterAdmin, entered2 = false;
  const env2 = await ready(async (point, d, env) => {
    if (point !== 'schedule:before_final_txn' || entered2) return;
    entered2 = true;
    await stall();
    adminRun = await admin(env, 'POST', `/v1/admin/runs/${d.runId}/compute`, { reason: 'operator recompute (test)' });
    afterAdmin = await digest(env);
  });
  const owner2 = await schedule(env2);
  assert.deepEqual([adminRun.status, adminRun.json.state, owner2.status, owner2.json.error], [200, 'validated', 409, 'ownership_lost']);
  assert.equal(await digest(env2), afterAdmin);
  const c = await consistent(env2);
  assert.deepEqual([c.cycles, c.runs, c.snapshots, c.orphanSnapshots, c.contiguousSeq, c.state], [1, 1, 1, 0, true, 'validated']);
});

test('the final transaction also requires the run to be exactly as the owner left it (not just "computing")', async () => {
  let atBounce;
  const env = await ready(async (point, d, env) => {
    if (point !== 'schedule:before_final_txn') return;
    // Any writer bouncing the run computing → failed → computing (claim unchanged).
    await env.DB.prepare("UPDATE reporting_run SET state = 'computing', updated_at = ?2 WHERE run_id = ?1").bind(d.runId, new Date(Date.now() + 1000).toISOString()).run();
    atBounce = await digest(env, RUN_TABLES);
  });
  const r = await schedule(env);
  assert.deepEqual([r.status, r.json.error], [409, 'concurrent_transition']);
  assert.equal(await digest(env, RUN_TABLES), atBounce, 'the owner changed no run, transition or snapshot row');
  // The claim holder records why on its own cycle row.
  assert.equal((await one(env, 'SELECT last_error FROM schedule_cycle')).last_error, 'concurrent_transition');
});
