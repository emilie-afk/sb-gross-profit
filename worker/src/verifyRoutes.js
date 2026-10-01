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

const P = (s, d = null) => { try { return JSON.parse(s); } catch { return d; } };
export const REPORT_STATUSES = ['verified', 'mismatch', 'unavailable'];
export const PUBLIC_REPORT_KEYS = ['status', 'reason', 'ordersChecked', 'orderMismatches', 'sectionsChecked', 'sectionMismatches', 'sequenceMatches',
  'provenanceChecked', 'provenanceMismatches', 'durationMs', 'engineVersion', 'verifierCommit'];
const MAX_DIFF_CHARS = 256 * 1024;

export async function pendingVerifications(env) {
  const r = (await env.DB.prepare(`SELECT s.snapshot_id, s.week_start, s.revision, v.status AS vstatus, v.attempts FROM snapshot s
      LEFT JOIN verify_report v ON v.snapshot_id = s.snapshot_id
      WHERE s.storage = 'chunked' AND (v.status IS NULL OR v.status = 'unavailable') ORDER BY s.computed_at DESC LIMIT 20`).all()).results || [];
  return json({ pending: r.map(x => ({ snapshotId: x.snapshot_id, weekStart: x.week_start, revision: x.revision, lastStatus: x.vstatus || null, attempts: x.attempts || 0 })) });
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
  return json({ snapshotId: id, weekStart: s.week_start, revision: s.revision, status: s.status, manifestHash: u.manifest_hash,
    manifest: P(u.manifest, {}), index: { engineVersion: index.engineVersion, parts: index.parts, orders: index.orders },
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
