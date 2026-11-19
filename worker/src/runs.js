/**
 * runs.js — the reporting-run state machine
 * =========================================
 *
 *   created ──► computing ──► draft ──► validated ──► published
 *                  │            │  └──► blocked ──┐
 *                  ▼            └──────────────┐  │
 *                failed ◄───────────────────── computing (recompute)
 *
 * - `draft` means a snapshot was written; the gate decides validated vs blocked.
 * - `published` is terminal. A correction is a NEW run that writes a new
 *   snapshot revision; the published revision is marked superseded, never edited.
 * - Publication additionally needs the go-live switch (shared/gate.js canPublish).
 *   validated → published happens in the SAME D1 transaction as the snapshot's
 *   status change (compute.js publishSnapshot), so the two can never disagree.
 */
import { ApiError } from './http.js';
import { newId, nowIso } from './db.js';

// Every `actor` argument below is { cls, label } from actor.js: cls is
// server-assigned from the auth path; label is caller-supplied and unverified.

/*
 * C7 (scheduled cycles): a run with missing sources waits WITHOUT a snapshot.
 *
 *   created ──► waiting_for_sources ──► computing            (sources arrive)
 *                     │
 *                     └──► source_timeout ──► computing      (cutoff passed; a later valid upload resumes it)
 *   failed ──► waiting_for_sources                           (a resumed run whose inputs are gone again)
 */
export const RUN_STATES = Object.freeze(['created', 'waiting_for_sources', 'source_timeout', 'computing', 'draft', 'validated', 'blocked', 'failed', 'published', 'cancelled']);

export const TRANSITIONS = Object.freeze({
  created:             ['computing', 'waiting_for_sources', 'cancelled'],
  waiting_for_sources: ['computing', 'source_timeout', 'cancelled'],
  source_timeout:      ['computing', 'cancelled'],
  computing:           ['draft', 'failed'],
  draft:               ['validated', 'blocked', 'computing'],
  validated:           ['published', 'computing', 'cancelled'],
  blocked:             ['computing', 'cancelled'],
  failed:              ['computing', 'waiting_for_sources', 'cancelled'],
  published:           [],
  cancelled:           [],
});

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) throw new ApiError(409, 'invalid_transition', `Run cannot move from ${from} to ${to}`);
}

/** The statements that create a run (used alone, or inside a larger batch such as a schedule claim). */
export function createRunStatements(db, runId, weekStart, trigger, actor, reason = null, at = nowIso()) {
  return [
    db.prepare('INSERT INTO reporting_run (run_id, week_start, state, trigger, created_at, updated_at, reason) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)')
      .bind(runId, weekStart, 'created', trigger, at, reason),
    db.prepare('INSERT INTO run_transition (run_id, seq, from_state, to_state, at, actor_class, actor_label, note) VALUES (?1, 0, NULL, ?2, ?3, ?4, ?5, ?6)')
      .bind(runId, 'created', at, actor.cls, actor.label, trigger),
  ];
}

export async function createRun(db, weekStart, trigger, actor, reason = null) {
  const runId = newId('run');
  await db.batch(createRunStatements(db, runId, weekStart, trigger, actor, reason));
  return getRun(db, runId);
}

export async function getRun(db, runId) {
  const r = await db.prepare('SELECT * FROM reporting_run WHERE run_id = ?1').bind(runId).first();
  if (!r) throw new ApiError(404, 'run_unknown', `No run ${runId}`);
  return r;
}

/**
 * Move a run to `to`. A guard statement aborts the whole batch unless the run
 * is still in the state it was read in, so a concurrent transition can never
 * leave a transition record without the matching state change (or vice versa).
 */
export async function transition(db, runId, to, actor, { note = null, fields = {}, ownership = null } = {}) {
  const run = await getRun(db, runId);
  assertTransition(run.state, to);
  const at = nowIso();
  const sets = ['state = ?2', 'updated_at = ?3'];
  const vals = [runId, to, at];
  for (const [k, v] of Object.entries(fields)) {
    if (!['catalog_rev', 'snapshot_id', 'gate', 'error'].includes(k)) continue;
    vals.push(v); sets.push(`${k} = ?${vals.length}`);
  }
  vals.push(run.state);
  const fromParam = `?${vals.length}`;
  try {
    await db.batch([
      // Scheduled cycles: only the current claim holder may change the run.
      ...(ownership ? [db.prepare('INSERT INTO write_guard (ok) SELECT NULL WHERE NOT EXISTS (SELECT 1 FROM schedule_cycle WHERE week_start = ?1 AND claim_token = ?2)')
        .bind(ownership.weekStart, ownership.token)] : []),
      db.prepare('INSERT INTO write_guard (ok) SELECT NULL WHERE NOT EXISTS (SELECT 1 FROM reporting_run WHERE run_id = ?1 AND state = ?2)').bind(runId, run.state),
      db.prepare(`INSERT INTO run_transition (run_id, seq, from_state, to_state, at, actor_class, actor_label, note)
        SELECT ?1, (SELECT COALESCE(MAX(seq), -1) + 1 FROM run_transition WHERE run_id = ?1), ?2, ?3, ?4, ?5, ?6, ?7`)
        .bind(runId, run.state, to, at, actor.cls, actor.label, note),
      db.prepare(`UPDATE reporting_run SET ${sets.join(', ')} WHERE run_id = ?1 AND state = ${fromParam}`).bind(...vals),
    ]);
  } catch (e) {
    if (/NOT NULL constraint failed: write_guard/i.test(String(e?.message || e))) {
      if (ownership && !(await ownsCycle(db, ownership))) {
        throw new ApiError(409, 'ownership_lost', 'Another request now owns this scheduled cycle; the run was not changed');
      }
      throw new ApiError(409, 'concurrent_transition', `Run ${runId} changed state concurrently; re-read it`);
    }
    throw e;
  }
  return getRun(db, runId);
}

/** Does this request still hold the scheduled cycle's claim? */
export async function ownsCycle(db, ownership) {
  return !!(await db.prepare('SELECT 1 AS x FROM schedule_cycle WHERE week_start = ?1 AND claim_token = ?2')
    .bind(ownership.weekStart, ownership.token).first());
}
