/**
 * verifyRoutes.js — the independent verifier's narrow API (X-Verify-Secret)
 * =========================================================================
 * GET  /v1/verify/pending                     chunked snapshots not yet verified (ids and weeks only)
 * GET  /v1/verify/snapshots/:id               pinned manifest + result index + the stored snapshot row, totals and narrative
 * GET  /v1/verify/snapshots/:id/parts/:name   one stored result part (gzip, as the dashboard reads it)
 * POST /v1/verify/snapshots/:id/report        { report, diff }  one report per snapshot (upsert; attempts counted)
 *
 * Plus the read-only /v1/collect parts routes (order bodies, Shipping Cost
 * Report dates, catalog parts, aux records, sources). The credential can read
 * pinned inputs and stored results and write exactly one kind of row
 * (verify_report). The report's public part is counts and codes only; the
 * field-level difference is stored for the logged-in dashboard and never
 * returned to the verifier's caller or logged.
 */
import { ApiError, json, readJson } from './http.js';
import { nowIso } from './db.js';
import { blobBytes } from './gz.js';

import { ENGINE_VERSION } from '../../shared/snapshot.js';
const P = (s, d = null) => { try { return JSON.parse(s); } catch { return d; } };
export const REPORT_STATUSES = ['verified', 'mismatch', 'unavailable'];
export const PUBLIC_REPORT_KEYS = ['status', 'reason', 'ordersChecked', 'orderMismatches', 'sectionsChecked', 'sectionMismatches', 'sequenceMatches',
  'provenanceChecked', 'provenanceMismatches', 'durationMs', 'engineVersion', 'verifierCommit', 'gateInputsMatch', 'gateMatches', 'gateHash'];
const MAX_DIFF_CHARS = 256 * 1024;

/**
 * The newest collector-computed revision of each week that still has no verification (or whose
 * verifier could not run), on this engine: the work a run must finish. Older revisions of a week
 * are never listed. Paged by week (?1 = after this week, ?2 = page size, ?3 = engine version).
 * A newest draft from another engine cannot be verified by this verifier (it needs a recompute);
 * it is counted as `otherEngine`, not listed.
 */
export const PENDING_VERIFICATION_SQL = `SELECT s.snapshot_id, s.week_start, s.revision, s.engine_version, v.status AS vstatus, v.attempts FROM snapshot s
      LEFT JOIN verify_report v ON v.snapshot_id = s.snapshot_id
      WHERE s.storage = 'chunked' AND (v.status IS NULL OR v.status = 'unavailable') AND s.week_start > ?1
        AND NOT EXISTS (SELECT 1 FROM snapshot n WHERE n.week_start = s.week_start AND n.revision > s.revision)
      ORDER BY s.week_start LIMIT ?2`;
/** Is any newest chunked revision of this engine (?1) still unverified? One row at most: the engine filter
 *  is applied in SQL before LIMIT 1, so drafts of older engines ahead of it never hide it, and the daily
 *  work check never fetches the backlog. */
export const CURRENT_ENGINE_PENDING_SQL = `SELECT s.snapshot_id FROM snapshot s
      LEFT JOIN verify_report v ON v.snapshot_id = s.snapshot_id
      WHERE s.storage = 'chunked' AND s.engine_version = ?1 AND (v.status IS NULL OR v.status = 'unavailable')
        AND NOT EXISTS (SELECT 1 FROM snapshot n WHERE n.week_start = s.week_start AND n.revision > s.revision)
      LIMIT 1`;
export const PENDING_PAGE_MAX = 50;
export async function pendingVerifications(env, request = null) {
  const q = request ? new URL(request.url).searchParams : new URLSearchParams();
  const after = q.get('after') || '0000-00-00';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(after) && after !== '0000-00-00') throw new ApiError(400, 'bad_query', 'after must be YYYY-MM-DD');
  const limit = Math.min(PENDING_PAGE_MAX, Math.max(1, Number(q.get('limit')) || 20));
  // One row more than the page tells whether another page follows.
  const rows = (await env.DB.prepare(PENDING_VERIFICATION_SQL).bind(after, limit + 1).all()).results || [];
  const page = rows.slice(0, limit);
  const mine = page.filter(x => x.engine_version === ENGINE_VERSION);
  return json({ pending: mine.map(x => ({ snapshotId: x.snapshot_id, weekStart: x.week_start, revision: x.revision, lastStatus: x.vstatus || null, attempts: x.attempts || 0 })),
                otherEngine: page.length - mine.length, next: rows.length > limit ? page[page.length - 1].week_start : null });
}

async function chunked(db, id) {
  const s = await db.prepare("SELECT * FROM snapshot WHERE snapshot_id = ?1 AND storage = 'chunked'").bind(id).first();
  if (!s) throw new ApiError(404, 'snapshot_unknown', 'No such collector-computed snapshot');
  return s;
}

export async function verifyInputs(env, id) {
  const db = env.DB;
  const s = await chunked(db, id);
  const u = await db.prepare('SELECT manifest, manifest_hash, idx FROM result_upload WHERE snapshot_id = ?1').bind(id).first();
  const { snapshot_id: _i, ...totals } = await db.prepare('SELECT * FROM snapshot_totals WHERE snapshot_id = ?1').bind(id).first() || {};
  const narrative = (await db.prepare('SELECT narrative FROM snapshot_narrative WHERE snapshot_id = ?1').bind(id).first())?.narrative ?? null;
  const index = P(u.idx, {});
  const run = await db.prepare('SELECT gate FROM reporting_run WHERE run_id = ?1').bind(s.run_id).first();
  return json({ snapshotId: id, weekStart: s.week_start, revision: s.revision, status: s.status, manifestHash: u.manifest_hash,
    manifest: P(u.manifest, {}), index: { engineVersion: index.engineVersion, parts: index.parts, orders: index.orders, gateInputs: index.gateInputs ?? null },
    gate: P(run?.gate, null),
    stored: { head: { engine_version: s.engine_version, catalog_rev: s.catalog_rev, policy: s.policy, profitability_status: s.profitability_status,
                      comparison_snapshot_id: s.comparison_snapshot_id, draft_comparison: s.draft_comparison }, totals, narrative } });
}

export async function verifyPart(env, id, name) {
  await chunked(env.DB, id);
  const r = await env.DB.prepare('SELECT body FROM snapshot_blob WHERE snapshot_id = ?1 AND part = ?2').bind(id, name).first();
  if (!r) throw new ApiError(404, 'part_unknown', 'No such part');
  return new Response(blobBytes(r.body), { headers: { 'Content-Type': 'application/gzip', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

export async function postVerifyReport(request, env, id) {
  const db = env.DB;
  await chunked(db, id);
  const b = await readJson(request);
  const rep = b.report || {};
  if (!REPORT_STATUSES.includes(rep.status)) throw new ApiError(400, 'bad_payload', `report.status must be one of ${REPORT_STATUSES.join(', ')}`);
  for (const [k, v] of Object.entries(rep)) {
    if (!PUBLIC_REPORT_KEYS.includes(k)) throw new ApiError(400, 'bad_payload', `report.${k} is not an allowed field`);
    if (!(typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && /^[\w.:-]{1,64}$/.test(v)))) throw new ApiError(400, 'bad_payload', `report.${k} must be a number, boolean or code`);
  }
  const diff = rep.status === 'mismatch' ? JSON.stringify(b.diff ?? null) : null;
  if (diff && diff.length > MAX_DIFF_CHARS) throw new ApiError(413, 'payload_too_large', 'diff too large');
  const at = nowIso();
  await db.prepare(`INSERT INTO verify_report (snapshot_id, status, report, diff, attempts, first_at, at) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)
      ON CONFLICT(snapshot_id) DO UPDATE SET status = excluded.status, report = excluded.report, diff = excluded.diff,
        attempts = verify_report.attempts + 1, at = excluded.at`)
    .bind(id, rep.status, JSON.stringify(rep), diff, at).run();
  return json({ snapshotId: id, status: rep.status, recorded: true });
}

/** Verification state of snapshots, for read routes and the week status. */
export async function verificationOf(db, ids, { admin = false } = {}) {
  if (!ids.length) return new Map();
  const r = (await db.prepare('SELECT snapshot_id, status, report, diff, attempts, at FROM verify_report WHERE snapshot_id IN (SELECT value FROM json_each(?1))')
    .bind(JSON.stringify(ids)).all()).results || [];
  return new Map(r.map(x => [x.snapshot_id, { status: x.status, at: x.at, attempts: x.attempts, report: P(x.report, {}),
    ...(admin && x.diff ? { diff: P(x.diff, null) } : {}) }]));
}
