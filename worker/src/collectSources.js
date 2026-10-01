/**
 * collectSources.js — sanitized source files, validated before retention (Free-tier path)
 * ======================================================================================
 * POST /v1/collect/sources                    manifest: kind, segment hashes and row counts, declared totals, window
 * PUT  /v1/collect/sources/:id/segments/:seq  one gzip segment (≤ 100 CSV rows, header repeated)
 * POST /v1/collect/sources/:id/seal           all segments present and validated, sums equal what was declared
 * GET  /v1/collect/sources/:id                meta + segment list        (ingest or verify credential)
 * GET  /v1/collect/sources/:id/segments/:seq  the retained gzip segment  (ingest or verify credential)
 *
 * Raw customer exports never reach the Worker: the collector sanitizes on the
 * office PC and uploads the sanitized file in segments sized for one Workers Free
 * request each. Each segment is hash-checked, decompressed with a byte cap
 * (zip-bomb guard), parsed and passed through the same privacy guards as the
 * csv_text routes before its one row is written. Any failure rejects the whole
 * source: its segments are deleted and only an error CODE is returned — never a
 * value, row or file name. An identical re-export (same segment hashes) answers
 * `already_have` and writes nothing.
 */
import { ApiError, json, readJson } from './http.js';
import { newId, nowIso, getSettings } from './db.js';
import { readBytes, gunzipCapped, sha256Bytes, sha256Text, HEX64, blobBytes } from './gz.js';
import { parseCSV } from '../../shared/calculator.js';
import { assertSanitizedShopifyOrderRows } from '../../shared/adapters/shopifyCsv.js';
import { assertReducedShopifyOrderRows } from '../../shared/adapters/shopifyPrivacy.js';
import { CustomerDataError } from '../../shared/normalized.js';
import { validateScrSegment, sumFacts, SCR_SEGMENT_ROWS, DEFAULT_REVIEW_CAP_CENTS } from '../../shared/scrDays.js';

export const KINDS = ['shopify', 'shipping_cost_report'];
export const SEGMENT_LIMITS = Object.freeze({ rows: 100, compressed: 64 * 1024, decompressed: 256 * 1024, ratio: 60, maxSegments: 400 });
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const P = s => { try { return JSON.parse(s); } catch { return null; } };

/** The source identity both sides compute: SHA-256 of the segment hashes, one per line. */
export const segmentListHash = hashes => sha256Text(hashes.join('\n'));

async function getSource(db, id) {
  const s = await db.prepare('SELECT * FROM src_object WHERE source_id = ?1').bind(id).first();
  if (!s) throw new ApiError(404, 'source_unknown', 'No such source');
  return { ...s, declared: P(s.declared) || {}, summary: P(s.summary) };
}

export async function openSource(request, env) {
  const b = await readJson(request);
  if (!KINDS.includes(b.kind)) throw new ApiError(400, 'bad_payload', `kind must be one of ${KINDS.join(', ')}`);
  const segs = Array.isArray(b.segments) ? b.segments : [];
  if (!segs.length || segs.length > SEGMENT_LIMITS.maxSegments) throw new ApiError(400, 'bad_payload', `1–${SEGMENT_LIMITS.maxSegments} segments required`);
  for (const s of segs) if (!HEX64.test(s?.sha256 || '') || !Number.isInteger(s.rows) || s.rows < 1 || s.rows > SEGMENT_LIMITS.rows) throw new ApiError(400, 'bad_payload', 'Each segment needs a sha256 and 1–100 rows');
  const sha256 = await segmentListHash(segs.map(s => s.sha256));
  if (b.sha256 !== sha256) throw new ApiError(400, 'hash_mismatch', 'sha256 must be the hash of the segment-hash list');
  const rows = segs.reduce((n, s) => n + s.rows, 0);
  if (b.rows !== rows) throw new ApiError(400, 'bad_payload', 'rows must equal the sum of segment rows');
  if (!DATE.test(b.window?.from || '') || !DATE.test(b.window?.to || '') || b.window.from > b.window.to) throw new ApiError(400, 'bad_payload', 'window { from, to } must be YYYY-MM-DD');
  if (b.exportedAt !== undefined && Number.isNaN(Date.parse(b.exportedAt))) throw new ApiError(400, 'bad_payload', 'exportedAt must be an ISO time');
  if (b.kind === 'shipping_cost_report' && !Number.isInteger(b.cents)) throw new ApiError(400, 'bad_payload', 'cents (declared Shipping Cost total) is required');
  const db = env.DB;
  const existing = await db.prepare("SELECT source_id, status, segment_count FROM src_object WHERE kind = ?1 AND sha256 = ?2 AND status <> 'rejected'").bind(b.kind, sha256).first();
  if (existing?.status === 'retained') return json({ sourceId: existing.source_id, status: 'already_have', missing: [] });
  if (existing) {
    const have = new Set(((await db.prepare('SELECT seq FROM src_segment WHERE source_id = ?1').bind(existing.source_id).all()).results || []).map(r => r.seq));
    return json({ sourceId: existing.source_id, status: 'open', missing: segs.map((_, i) => i).filter(i => !have.has(i)) });
  }
  const sourceId = newId('src');
  const declared = { rows, cents: b.cents ?? null, window: b.window, exportedAt: b.exportedAt || null, weekStart: b.weekStart || null,
                     segments: segs.map(s => [s.sha256, s.rows]) };
  try {
    await db.prepare('INSERT INTO src_object (source_id, kind, sha256, status, segment_count, declared, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
      .bind(sourceId, b.kind, sha256, 'pending', segs.length, JSON.stringify(declared), nowIso()).run();
  } catch (e) {
    // A duplicate delivery of the same manifest raced this one: answer with the first.
    if (!/UNIQUE constraint failed/i.test(String(e?.message || e))) throw e;
    const first = await db.prepare("SELECT source_id, status FROM src_object WHERE kind = ?1 AND sha256 = ?2 AND status <> 'rejected'").bind(b.kind, sha256).first();
    if (!first) throw e;
    return json({ sourceId: first.source_id, status: first.status === 'retained' ? 'already_have' : 'open', missing: first.status === 'retained' ? [] : segs.map((_, i) => i) });
  }
  return json({ sourceId, status: 'open', missing: segs.map((_, i) => i) });
}

async function reject(db, sourceId, code) {
  await db.batch([
    db.prepare("UPDATE src_object SET status = 'rejected', error = ?2 WHERE source_id = ?1 AND status = 'pending'").bind(sourceId, code),
    db.prepare('DELETE FROM src_segment WHERE source_id = ?1').bind(sourceId),
  ]);
}

export async function putSegment(request, env, sourceId, seqText) {
  const db = env.DB;
  const src = await getSource(db, sourceId);
  if (src.status === 'retained') return json({ sourceId, seq: Number(seqText), status: 'already_have' });
  if (src.status !== 'pending') throw new ApiError(409, 'source_rejected', `This source was rejected (${src.error})`, { code: src.error });
  const seq = Number(seqText);
  const want = src.declared.segments?.[seq];
  if (!Number.isInteger(seq) || !want) throw new ApiError(400, 'bad_payload', 'No such segment number');
  const bytes = await readBytes(request, SEGMENT_LIMITS.compressed);
  if (await sha256Bytes(bytes) !== want[0]) throw new ApiError(400, 'hash_mismatch', 'Segment bytes do not match the declared hash');
  let facts;
  try {
    const text = await gunzipCapped(bytes, Math.min(SEGMENT_LIMITS.decompressed, bytes.byteLength * SEGMENT_LIMITS.ratio));
    const rows = parseCSV(text.replace(/^\uFEFF/, ''));
    if (rows.length !== want[1]) throw Object.assign(new Error('row_count_mismatch'), { code: 'row_count_mismatch' });
    if (src.kind === 'shopify') {
      assertSanitizedShopifyOrderRows(rows);            // customer columns → rejected, not dropped (same guard as csv_text)
      assertReducedShopifyOrderRows(rows);              // free text already in its minimum form
      facts = { rows: rows.length };
    } else {
      const s = await getSettings(db);
      if (rows.length > SCR_SEGMENT_ROWS) throw Object.assign(new Error('segment_too_many_rows'), { code: 'segment_too_many_rows' });
      facts = validateScrSegment(rows, { expectedStore: s.shipping_report_store, capCents: Number(s.shipping_cost_review_cap_cents ?? DEFAULT_REVIEW_CAP_CENTS),
                                         from: src.declared.window.from, to: src.declared.window.to });
    }
  } catch (e) {
    const code = e instanceof CustomerDataError ? 'customer_data_rejected' : (e.code || 'segment_invalid');
    await reject(db, sourceId, code);
    throw new ApiError(400, code, 'Segment failed validation; the whole source was rejected and nothing was retained');
  }
  await db.prepare('INSERT OR IGNORE INTO src_segment (source_id, seq, sha256, rows, raw_bytes, facts, body) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
    .bind(sourceId, seq, want[0], want[1], bytes.byteLength, JSON.stringify(facts), bytes).run();
  return json({ sourceId, seq, status: 'stored' });
}

export async function sealSource(request, env, sourceId) {
  const db = env.DB;
  const src = await getSource(db, sourceId);
  if (src.status === 'retained') return json({ sourceId, status: 'retained', summary: src.summary, already: true });
  if (src.status !== 'pending') throw new ApiError(409, 'source_rejected', `This source was rejected (${src.error})`, { code: src.error });
  const segs = (await db.prepare('SELECT seq, sha256, rows, facts FROM src_segment WHERE source_id = ?1 ORDER BY seq').bind(sourceId).all()).results || [];
  if (segs.length !== src.segment_count) throw new ApiError(409, 'segments_missing', `${src.segment_count - segs.length} segment(s) not uploaded yet`, { missing: src.segment_count - segs.length });
  let summary;
  if (src.kind === 'shipping_cost_report') {
    const f = sumFacts(segs.map(s => P(s.facts)));
    if (f.rows !== src.declared.rows || f.cents !== src.declared.cents) {
      await reject(db, sourceId, 'declared_totals_mismatch');
      throw new ApiError(400, 'declared_totals_mismatch', 'Validated segment sums differ from the declared rows or total; the source was rejected');
    }
    summary = f;
  } else {
    const rows = segs.reduce((n, s) => n + s.rows, 0);
    if (rows !== src.declared.rows) { await reject(db, sourceId, 'declared_totals_mismatch'); throw new ApiError(400, 'declared_totals_mismatch', 'Row count differs from the declaration'); }
    summary = { rows };
  }
  await db.prepare("UPDATE src_object SET status = 'retained', summary = ?2, sealed_at = ?3 WHERE source_id = ?1 AND status = 'pending'")
    .bind(sourceId, JSON.stringify(summary), nowIso()).run();
  return json({ sourceId, status: 'retained', summary: { rows: summary.rows, flags: summary.flags || {} } });
}

export async function getSourceMeta(env, sourceId) {
  const s = await getSource(env.DB, sourceId);
  return json({ sourceId, kind: s.kind, status: s.status, sha256: s.sha256, window: s.declared.window, exportedAt: s.declared.exportedAt,
                rows: s.declared.rows, segments: (s.declared.segments || []).map(([h, n]) => ({ sha256: h, rows: n })), sealedAt: s.sealed_at });
}

export async function getSegment(env, sourceId, seqText) {
  const r = await env.DB.prepare("SELECT g.body FROM src_segment g JOIN src_object o ON o.source_id = g.source_id WHERE g.source_id = ?1 AND g.seq = ?2 AND o.status = 'retained'")
    .bind(sourceId, Number(seqText)).first();
  if (!r) throw new ApiError(404, 'segment_unknown', 'No such retained segment');
  return new Response(blobBytes(r.body), { headers: { 'Content-Type': 'application/gzip', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
