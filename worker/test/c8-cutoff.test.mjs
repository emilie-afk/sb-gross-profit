/**
 * C8 — the Tuesday 15:30 ICT cutoff boundary. The attempt at the cutoff first
 * evaluates every upload recorded THROUGH the cutoff instant; only if a
 * required source is still missing after that evaluation does the run become
 * source_timeout. An upload recorded after the instant is not counted by that
 * attempt, is not marked as seen, and resumes the same run on the next tick.
 * Synthetic data only; the Cron handler is invoked directly (test env).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { loaded, ingest, viaNormalized, WEEK, asOf, stampSince, ingestReport } from './helpers.mjs';

const CUTOFF = '2026-09-22T08:30:00.000Z';                   // Tuesday 15:30 ICT for the week of 2026-09-14
const rawTick = (env, iso) => worker.scheduled({ scheduledTime: Date.parse(iso) }, env, null);     // the tick instant, exactly
const tick = async (env, iso) => { await asOf(env, iso); return rawTick(env, iso); };
const cycleRow = env => env.DB.prepare('SELECT * FROM schedule_cycle WHERE week_start = ?1').bind(WEEK).first();
const runOf = async env => env.DB.prepare('SELECT * FROM reporting_run WHERE run_id = ?1').bind((await cycleRow(env)).run_id).first();
const count = async (env, table) => (await env.DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first()).n;
const states = async env => ((await env.DB.prepare('SELECT to_state FROM run_transition WHERE run_id = ?1 ORDER BY seq').bind((await cycleRow(env)).run_id).all()).results || []).map(r => r.to_state);

/** Waiting all Monday for the Shipping Cost Report; it lands at `uploadIso`; then the cutoff attempt runs. */
async function boundary(uploadIso) {
  const { env, nodes } = await loaded(20, { TEST_HOOKS_ENABLED: 'true' }, { shippingReport: false });
  assert.equal((await ingest(env, '/v1/ingest/shopify', viaNormalized({ mode: 'updated_since', nodes: [], weekStart: WEEK }))).status, 200);
  await tick(env, '2026-09-21T08:30:00Z');                                   // first attempt: waiting
  await tick(env, '2026-09-22T07:30:00Z');                                   // last hourly retry before the cutoff
  assert.equal((await cycleRow(env)).status, 'waiting_for_sources');
  const since = new Date().toISOString();
  await ingestReport(env, nodes.map((o, i) => ({ order: o.name.slice(1), date: `2026-09-${15 + (i % 5)}`, cost: 5.1 })));
  await stampSince(env, since, uploadIso);                                   // received (and accepted) exactly at uploadIso
  const r = await rawTick(env, CUTOFF);
  return { env, r, cycle: await cycleRow(env), run: await runOf(env) };
}

test('C8 cutoff: an upload immediately BEFORE 15:30 is evaluated first → draft computed, no source_timeout', async () => {
  const { env, cycle, run } = await boundary('2026-09-22T08:29:59.999Z');
  assert.ok(['validated', 'blocked'].includes(run.state), run.state);
  assert.equal(cycle.status, 'computed');
  assert.equal(cycle.timed_out_at, null);
  assert.ok(!(await states(env)).includes('source_timeout'));
  assert.equal(await count(env, 'snapshot'), 1);
  assert.equal(JSON.parse(run.gate).shippingReport.used[0].receivedAt, '2026-09-22T08:29:59.999Z');
});

test('C8 cutoff: an upload EXACTLY at 15:30:00.000 counts → draft computed, no source_timeout', async () => {
  const { env, cycle, run } = await boundary(CUTOFF);
  assert.ok(['validated', 'blocked'].includes(run.state), run.state);
  assert.deepEqual([cycle.status, cycle.timed_out_at], ['computed', null]);
  assert.ok(!(await states(env)).includes('source_timeout'));
  assert.equal(await count(env, 'snapshot'), 1);
});

test('C8 cutoff: an upload immediately AFTER 15:30 is not counted → source_timeout, then the same run resumes on the next tick', async () => {
  const { env, cycle, run, r } = await boundary('2026-09-22T08:30:00.001Z');
  assert.equal(run.state, 'source_timeout');
  assert.deepEqual(r.attempts[0].missing, ['shipping_cost_report:missing'], 'evaluated through 15:30:00.000 only');
  assert.deepEqual([cycle.status, cycle.timed_out_at], ['source_timeout', CUTOFF]);
  assert.notEqual(cycle.changes_seen_at, cycle.sources_changed_at, 'a change recorded after the tick instant is not marked seen');
  assert.equal(await count(env, 'snapshot'), 0);
  // The next tick sees the late upload and resumes the SAME run into one draft.
  const next = await rawTick(env, '2026-09-22T08:45:00.000Z');
  const after = await runOf(env);
  assert.equal(after.run_id, run.run_id);
  assert.ok(['validated', 'blocked'].includes(after.state), after.state);
  assert.deepEqual((await states(env)).filter(s => s === 'source_timeout').length, 1);
  assert.equal((await cycleRow(env)).timed_out_at, CUTOFF, 'the timeout stays on record');
  assert.equal(await count(env, 'snapshot'), 1);
  assert.equal(next.attempts.length, 1);
  assert.equal(JSON.parse(after.gate).shippingReport.used[0].receivedAt, '2026-09-22T08:30:00.001Z');
});

test('C8 cutoff: nothing arrives → the cutoff attempt still evaluates first, then times out once', async () => {
  const { env } = await loaded(20, { TEST_HOOKS_ENABLED: 'true' }, { shippingReport: false });
  await tick(env, '2026-09-21T08:30:00Z');
  const r = await rawTick(env, CUTOFF);
  assert.deepEqual([r.attempts[0].state, r.attempts[0].missing], ['source_timeout', ['shopify_updates:missing', 'shipping_cost_report:missing']]);
  assert.equal((await cycleRow(env)).timed_out_at, CUTOFF);
  assert.deepEqual((await rawTick(env, '2026-09-22T09:30:00.000Z')).attempts, [], 'no further attempts without a new upload');
});
