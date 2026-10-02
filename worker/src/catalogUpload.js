/**
 * catalogUpload.js — chunked cost-catalog upload (Workers Free: bounded per-request CPU)
 * =====================================================================================
 * POST /v1/ingest/catalog/uploads                         { layout, meta, mcgExtraCsv? } → { uploadId }
 * PUT  /v1/ingest/catalog/uploads/:id/chunks/:table/:part { group?, entries }            (≤ 96 KB, ≤ 2,000 entries)
 * POST /v1/ingest/catalog/uploads/:id/seal                → the same answer as POST /v1/ingest/catalog
 *
 * The one-request push (POST /v1/ingest/catalog) parsed, hashed and stored the whole
 * catalog (~360 KB) in one Worker request: ~22 ms CPU on staging. Here every request
 * handles one chunk of key-sorted entries:
 *   layout     [[table, 1, n]]                       a table of n chunks of top-level entries
 *              [[table, 2, [[groupKey, n], ...]]]    a table of groups (vendor_costs: vendor →
 *                                                    SKU → cost), each in n chunks of its entries
 *   a chunk    stored as the exact fragment of the table's canonical (key-sorted) JSON text, so
 *              the fragments joined in part order ARE the table: readers (loadCatalog,
 *              catalogFromParts) are unchanged
 *   seal       checks every chunk is present and keys strictly increase across chunks, sums the
 *              per-chunk counts into the same validation as the one-request push
 *              (validateCatalogCounts), and copies the fragments into cost_catalog_part inside D1
 *   revision   catalogPartsRevOf: the hash of the parts' hashes (computed from stored hashes)
 * An identical push (same chunks) gets the same revision and writes no catalog rows again.
 * Sealing vs chunk writes (0018): a seal first freezes the upload ('sealing', with its own token);
 * chunk writes need status 'open' inside the write. The commit's first statement re-checks the token
 * and the exact (table, part, sha256) set that was validated; every other write in the commit
 * (catalog, parts, ingest record, refresh, schedule) is conditional on it. A failed seal reopens
 * the upload; a repeated seal of a sealed upload replays its stored answer.
 */
import { ApiError, json, readJson } from './http.js';
import { newId, nowIso, getSettings, atomic, SETTINGS_SQL, settingsFromRows } from './db.js';
import { REFRESH_ID_RE } from './ingest.js';
import { REFRESH_TIMEOUT_MINUTES } from './compute.js';
import { sha256Text } from './gz.js';
import { stableStringify, assertNoCustomerFields } from '../../shared/normalized.js';
import { CATALOG_TABLES, validateCatalogCounts, parseMcgExtraCsv, catalogPartsRevFromHashes } from '../../shared/catalog.js';

const P = (s, d = null) => { try { return JSON.parse(s); } catch { return d; } };
export const CATALOG_UPLOAD_LIMITS = Object.freeze({ chunkBytes: 96 * 1024, chunkEntries: 2000, chunks: 400, groups: 50, mcgExtraCsvBytes: 96 * 1024 });
const DEPTH2 = new Set(['vendor_costs']);
const bad = msg => new ApiError(400, 'bad_payload', msg);

/** The chunk positions of a layout entry: part → { g, i, n, G } (g = group index, i = index in group). */
function positions(entry) {
  const [, depth, spec] = entry;
  if (depth === 1) return Array.from({ length: spec }, (_, i) => ({ g: null, key: null, i, n: spec, G: 1 }));
  const out = [];
  spec.forEach(([key, n], g) => { for (let i = 0; i < n; i++) out.push({ g, key, i, n, G: spec.length }); });
  return out;
}
function checkLayout(layout) {
  if (!Array.isArray(layout) || !layout.length) throw bad('layout must list the tables');
  const seen = new Set(); let chunks = 0;
  for (const e of layout) {
    if (!Array.isArray(e) || e.length !== 3 || !CATALOG_TABLES.includes(e[0]) || seen.has(e[0])) throw bad('layout: [[table, depth, chunks]] with known tables, each once');
    seen.add(e[0]);
    const [t, depth, spec] = e;
    if (depth !== (DEPTH2.has(t) ? 2 : 1)) throw bad(`layout: ${t} has depth ${DEPTH2.has(t) ? 2 : 1}`);
    if (depth === 1) { if (!Number.isInteger(spec) || spec < 1) throw bad('layout: a table needs at least one chunk'); chunks += spec; }
    else {
      if (!Array.isArray(spec) || !spec.length || spec.length > CATALOG_UPLOAD_LIMITS.groups) throw bad('layout: groups must be [[key, chunks], ...] (at least one)');
      let prev = null;
      for (const g of spec) {
        if (!Array.isArray(g) || typeof g[0] !== 'string' || !Number.isInteger(g[1]) || g[1] < 1) throw bad('layout: groups must be [[key, chunks], ...]');
        if (prev !== null && !(g[0] > prev)) throw bad('layout: group keys must be strictly increasing');
        prev = g[0]; chunks += g[1];
      }
    }
  }
  if (chunks > CATALOG_UPLOAD_LIMITS.chunks) throw bad(`layout: at most ${CATALOG_UPLOAD_LIMITS.chunks} chunks`);
}

export async function openCatalogUpload(request, env) {
  const b = await readJson(request);
  checkLayout(b.layout);
  if (typeof b.mcgExtraCsv === 'string' && b.mcgExtraCsv.length > CATALOG_UPLOAD_LIMITS.mcgExtraCsvBytes) throw bad('mcgExtraCsv too large');
  const mcgExtra = typeof b.mcgExtraCsv === 'string' ? parseMcgExtraCsv(b.mcgExtraCsv) : {};
  try { assertNoCustomerFields(mcgExtra); } catch { throw new ApiError(400, 'customer_data_rejected', 'The catalog contains customer fields'); }
  const meta = { builtAt: typeof b.meta?.builtAt === 'string' ? b.meta.builtAt.slice(0, 40) : null, commit: typeof b.meta?.commit === 'string' ? b.meta.commit.slice(0, 64) : null,
                 refreshId: typeof b.meta?.refreshId === 'string' ? b.meta.refreshId.slice(0, 32) : null, source: 'build_push_chunked', mcgExtraCount: Object.keys(mcgExtra).length };
  const id = newId('cup'), at = nowIso();
  const fixed = [['__mcgExtra', stableStringify(mcgExtra)], ['__overrides', '{}']];
  const db = env.DB;
  await atomic(db, [
    db.prepare('INSERT INTO catalog_upload (upload_id, status, layout, meta, created_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(id, 'open', JSON.stringify(b.layout), JSON.stringify(meta), at),
    ...await Promise.all(fixed.map(async ([t, payload]) => db.prepare('INSERT INTO catalog_upload_part (upload_id, table_name, part, grp, first_key, last_key, n, sha256, payload) VALUES (?1, ?2, 0, NULL, NULL, NULL, ?3, ?4, ?5)')
      .bind(id, t, t === '__mcgExtra' ? meta.mcgExtraCount : 0, await sha256Text(payload), payload))),
  ]);
  return json({ uploadId: id, chunks: b.layout.reduce((n, e) => n + positions(e).length, 0) });
}


async function openUpload(db, id) {
  const u = await db.prepare('SELECT * FROM catalog_upload WHERE upload_id = ?1').bind(id).first();
  if (!u) throw new ApiError(404, 'upload_unknown', 'No such catalog upload');
  if (u.status !== 'open') throw new ApiError(409, 'upload_closed', `This upload is ${u.status}`);
  return u;
}

export async function putCatalogChunk(request, env, id, table, partText) {
  const db = env.DB;
  const text = await request.text();
  if (text.length > CATALOG_UPLOAD_LIMITS.chunkBytes) throw new ApiError(413, 'payload_too_large', 'A catalog chunk is at most 96 KB');
  const b = P(text);
  const u = await openUpload(db, id);
  const entry = P(u.layout, []).find(e => e[0] === table);
  if (!entry) throw bad('No such table in this upload');
  const part = Number(partText), pos = positions(entry)[part];
  if (!pos) throw bad('No such chunk in this upload');
  const entries = b?.entries;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw bad('entries must be an object');
  if ((pos.key ?? null) !== (b.group ?? null)) throw bad('group does not match the layout');
  const keys = Object.keys(entries).sort();
  if (keys.length > CATALOG_UPLOAD_LIMITS.chunkEntries) throw bad(`At most ${CATALOG_UPLOAD_LIMITS.chunkEntries} entries per chunk`);
  // Only a table (or group) of a single chunk may be empty: an empty middle chunk would break the text.
  if (!keys.length && pos.n !== 1) throw bad('Only a single-chunk table or group may be empty');
  try { assertNoCustomerFields(entries); } catch { throw new ApiError(400, 'customer_data_rejected', 'The catalog contains customer fields'); }
  const inner = stableStringify(entries).slice(1, -1);
  const open = pos.i === 0 ? (pos.g === null ? '{' : `${pos.g === 0 ? '{' : ','}${JSON.stringify(pos.key)}:{`) : ',';
  const close = pos.i === pos.n - 1 ? (pos.g === null ? '}' : `}${pos.g === pos.G - 1 ? '}' : ''}`) : '';
  const payload = open + inner + close;
  // The upload must still be open IN this statement: a seal freezes it (status 'sealing') before
  // reading the chunks, so no chunk can change between the seal's validation and its commit.
  const w = await db.prepare(`INSERT INTO catalog_upload_part (upload_id, table_name, part, grp, first_key, last_key, n, sha256, payload)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9 WHERE EXISTS (SELECT 1 FROM catalog_upload WHERE upload_id = ?1 AND status = 'open')
      ON CONFLICT(upload_id, table_name, part) DO UPDATE SET grp = excluded.grp, first_key = excluded.first_key, last_key = excluded.last_key, n = excluded.n, sha256 = excluded.sha256, payload = excluded.payload
      WHERE EXISTS (SELECT 1 FROM catalog_upload WHERE upload_id = excluded.upload_id AND status = 'open')`)
    .bind(id, table, part, pos.key, keys[0] ?? null, keys[keys.length - 1] ?? null, keys.length, await sha256Text(payload), payload).run();
  if (w.meta?.changes !== 1) throw new ApiError(409, 'upload_closed', 'This upload is being sealed or is sealed; chunks can no longer change');
  return json({ uploadId: id, table, part, entries: keys.length });
}

export const SEAL_STALE_SECONDS = 60;
// Every write of a seal's commit is conditional on the commit's first statement having sealed
// the upload with this seal's token (?1 = upload id, ?2 = token).
const SEALED_BY_ME = "EXISTS (SELECT 1 FROM catalog_upload WHERE upload_id = ?1 AND status = 'sealed' AND seal_token = ?2)";
// What was durably stored for an upload: its catalog, that catalog's parts, the refresh it names.
const STORED = db => [
  db.prepare('SELECT status FROM cost_catalog WHERE catalog_rev = (SELECT catalog_rev FROM catalog_upload WHERE upload_id = ?1)'),
  db.prepare('SELECT COUNT(*) AS n FROM cost_catalog_part WHERE catalog_rev = (SELECT catalog_rev FROM catalog_upload WHERE upload_id = ?1)'),
  db.prepare("SELECT status, json_extract(detail, '$.resolvedBy') AS resolved_by FROM catalog_refresh WHERE refresh_id = (SELECT json_extract(meta, '$.refreshId') FROM catalog_upload WHERE upload_id = ?1)"),
];

/** The seal's answer from what is stored: accepted only if the catalog row is accepted AND all its parts exist. */
function answerFrom(planned, [cr, pr, rr], replayed = false) {
  const { partCount, ...out } = planned;
  const catStatus = cr.results?.[0]?.status ?? null, parts = pr.results?.[0]?.n ?? 0, ref = rr.results?.[0] ?? null;
  const accepted = catStatus === 'accepted' && parts === partCount;
  let refresh = planned.refresh;
  if (['fulfilled', 'rejected', 'expired'].includes(refresh.status)) {
    refresh = ref?.resolved_by === planned.runId ? refresh
            : ref?.status === 'pending' ? { refreshId: refresh.refreshId, status: 'pending', note: 'the catalog was not stored; refresh not resolved' }
            : { refreshId: refresh.refreshId, status: 'already_resolved' };
  }
  return { ...out, accepted, status: catStatus ?? out.status, refresh, activeCatalogRev: accepted ? out.catalogRev : out.previousCatalogRev, ...(replayed ? { replayed: true } : {}) };
}
const publicAnswer = a => { const { previousCatalogRev, ...rest } = a; return rest; };

export async function sealCatalogUpload(request, env, id) {
  const db = env.DB;
  const token = newId('seal'), at = nowIso(), stale = new Date(Date.now() - SEAL_STALE_SECONDS * 1000).toISOString();
  // 1. Freeze, then read in the same transaction: chunk writes need status 'open', so the chunk
  //    metadata read here is what the commit below will copy (and the commit re-checks it).
  const [fr, ur, pr, sr, lr] = await db.batch([
    db.prepare(`UPDATE catalog_upload SET status = 'sealing', seal_token = ?2, sealing_at = ?3
        WHERE upload_id = ?1 AND (status = 'open' OR (status = 'sealing' AND sealing_at < ?4))`).bind(id, token, at, stale),
    db.prepare('SELECT * FROM catalog_upload WHERE upload_id = ?1').bind(id),
    db.prepare('SELECT table_name, part, grp, first_key, last_key, n, sha256 FROM catalog_upload_part WHERE upload_id = ?1').bind(id),
    db.prepare(SETTINGS_SQL),
    db.prepare("SELECT catalog_rev, table_counts, vendor_counts FROM cost_catalog WHERE status = 'accepted' ORDER BY COALESCE(last_pushed_at, captured_at) DESC, catalog_rev LIMIT 1"),
  ]);
  const u = ur.results?.[0];
  if (!u) throw new ApiError(404, 'upload_unknown', 'No such catalog upload');
  if (fr.meta?.changes !== 1) {
    if (u.status === 'sealed' && u.result) return json(publicAnswer(answerFrom(JSON.parse(u.result), await db.batch(STORED(db).map(s => s.bind(id))), true)));
    if (u.status === 'sealing') throw new ApiError(409, 'seal_in_progress', `Another seal of this upload is running; retry after ${SEAL_STALE_SECONDS} s`);
    throw new ApiError(409, 'upload_closed', `This upload is ${u.status}`);
  }
  const reopen = () => db.prepare("UPDATE catalog_upload SET status = 'open', seal_token = NULL, sealing_at = NULL WHERE upload_id = ?1 AND status = 'sealing' AND seal_token = ?2")
    .bind(id, token).run().catch(() => {});
  try {
    const layout = P(u.layout, []), meta = P(u.meta, {}), rows = pr.results || [];
    const byTable = new Map();
    for (const r of rows) (byTable.get(r.table_name) || byTable.set(r.table_name, []).get(r.table_name)).push(r);
    // 2. Completeness and key order (keys strictly increase across the chunks of a table or group).
    const tableCounts = Object.fromEntries(CATALOG_TABLES.map(t => [t, 0])), vendorCounts = {};
    for (const e of layout) {
      const pos = positions(e), got = (byTable.get(e[0]) || []).sort((a, b) => a.part - b.part);
      if (got.length !== pos.length || got.some((r, k) => r.part !== k)) throw new ApiError(409, 'chunks_missing', `${e[0]}: ${pos.length - got.length} chunk(s) not uploaded yet`);
      for (let k = 1; k < got.length; k++) {
        if (pos[k].g === pos[k - 1].g && !(got[k].first_key > got[k - 1].last_key)) throw new ApiError(400, 'chunk_order', `${e[0]}: keys must increase across chunks`);
      }
      if (e[1] === 1) tableCounts[e[0]] = got.reduce((n, r) => n + r.n, 0);
      else {
        tableCounts[e[0]] = e[2].length;
        if (e[0] === 'vendor_costs') for (const r of got) vendorCounts[r.grp] = (vendorCounts[r.grp] || 0) + r.n;
      }
    }
    tableCounts.mcgExtra = meta.mcgExtraCount || 0; tableCounts.overrides = 0;
    const counts = { tableCounts, vendorCounts, vendorTotal: Object.values(vendorCounts).reduce((sum, n) => sum + n, 0) };
    const hashes = rows.map(r => [r.table_name, r.part, r.sha256]);
    const rev = await catalogPartsRevFromHashes(hashes);
    const settings = settingsFromRows(sr.results || []), prev = lr.results?.[0] || null;
    const previous = prev ? { tableCounts: JSON.parse(prev.table_counts), vendorCounts: JSON.parse(prev.vendor_counts) } : null;
    const validation = validateCatalogCounts(counts, previous, { shrinkTolerance: Number(settings.catalog_shrink_tolerance) });
    const refreshId = meta.refreshId || null;
    const [er, rr] = await db.batch([
      db.prepare('SELECT status FROM cost_catalog WHERE catalog_rev = ?1').bind(rev),
      db.prepare('SELECT status, requested_at, detail FROM catalog_refresh WHERE refresh_id = ?1').bind(refreshId && REFRESH_ID_RE.test(refreshId) ? refreshId : ''),
    ]);
    const exists = er.results?.[0] || null;
    const runId = newId('ing');
    const accepted = exists ? exists.status === 'accepted' : validation.accepted;
    const status = exists ? exists.status : (validation.accepted ? 'accepted' : 'rejected');
    // 3. The refresh this push names: decided here, written only inside the commit, and fulfilled
    //    only if the catalog row is accepted and all its parts are stored in that same commit.
    let refresh, refreshStmts = [];
    if (!refreshId) refresh = { status: 'none', note: 'no refreshId in this push; no refresh resolved' };
    else if (!REFRESH_ID_RE.test(refreshId)) refresh = { status: 'invalid', note: 'malformed refreshId; no refresh resolved' };
    else if (!rr.results?.[0]) refresh = { refreshId, status: 'unknown', note: 'no such refresh; nothing resolved' };
    else if (rr.results[0].status !== 'pending') refresh = { refreshId, status: rr.results[0].status, note: 'already resolved; unchanged' };
    else {
      const r = rr.results[0];
      let prior = {}; try { prior = JSON.parse(r.detail || '{}') || {}; } catch { prior = {}; }
      if (!prior.auto && Date.now() - Date.parse(r.requested_at) > REFRESH_TIMEOUT_MINUTES * 60_000) {
        refresh = { refreshId, status: 'expired', note: 'refresh timed out before this push; not fulfilled' };
        refreshStmts.push(db.prepare(`UPDATE catalog_refresh SET status = 'expired', resolved_at = ?4, detail = ?5 WHERE refresh_id = ?3 AND status = 'pending' AND ${SEALED_BY_ME}`)
          .bind(id, token, refreshId, at, JSON.stringify({ lateCandidateRev: rev, note: `arrived after ${REFRESH_TIMEOUT_MINUTES} minutes`, resolvedBy: runId })));
      } else {
        const rs = accepted ? 'fulfilled' : 'rejected';
        refresh = { refreshId, status: rs };
        refreshStmts.push(
          db.prepare(`UPDATE catalog_refresh SET status = ?4, catalog_rev = ?5, resolved_at = ?6, detail = ?7 WHERE refresh_id = ?3 AND status = 'pending' AND ${SEALED_BY_ME}
              ${accepted ? 'AND EXISTS (SELECT 1 FROM cost_catalog WHERE catalog_rev = ?5 AND status = \'accepted\') AND (SELECT COUNT(*) FROM cost_catalog_part WHERE catalog_rev = ?5) = ?8' : 'AND ?8 IS NOT NULL'}`)
            .bind(id, token, refreshId, rs, accepted ? rev : null, at, JSON.stringify({ ...prior, reasons: validation.reasons || [], candidateRev: rev, resolvedBy: runId }), rows.length),
          db.prepare(`UPDATE schedule_cycle SET sources_changed_at = ?4 WHERE week_start = (SELECT week_start FROM catalog_refresh WHERE refresh_id = ?3 AND json_extract(detail, '$.resolvedBy') = ?5) AND ${SEALED_BY_ME}`)
            .bind(id, token, refreshId, at, runId));
      }
    }
    const diagnostics = { catalogRev: rev, accepted, reasons: validation.reasons, refresh };
    const planned = { runId, source: 'catalog', weekStart: null, mode: null, rowsSeen: 1, rowsWritten: exists ? 0 : 1, duplicates: exists ? 1 : 0, weeksTouched: {},
                      catalogRev: rev, accepted, status, reasons: validation.reasons, refresh, counts, previousCatalogRev: prev?.catalog_rev || null, partCount: rows.length };
    // 4. One commit. Its first statement seals the upload only if this seal still holds it AND the
    //    stored chunks are exactly the (table, part, sha256) set validated above; every other write
    //    is conditional on that, so a failed check writes nothing at all.
    const res = await db.batch([
      db.prepare(`UPDATE catalog_upload SET status = 'sealed', sealed_at = ?3, catalog_rev = ?4, result = ?5
          WHERE upload_id = ?1 AND status = 'sealing' AND seal_token = ?2
            AND (SELECT COUNT(*) FROM catalog_upload_part WHERE upload_id = ?1) = ?6
            AND NOT EXISTS (SELECT 1 FROM catalog_upload_part p WHERE p.upload_id = ?1 AND NOT EXISTS (
                  SELECT 1 FROM json_each(?7) e WHERE json_extract(e.value, '$[0]') = p.table_name AND json_extract(e.value, '$[1]') = p.part AND json_extract(e.value, '$[2]') = p.sha256))`)
        .bind(id, token, at, rev, JSON.stringify(planned), rows.length, JSON.stringify(hashes)),
      ...(exists
        ? (exists.status === 'accepted' ? [db.prepare(`UPDATE cost_catalog SET last_pushed_at = ?4 WHERE catalog_rev = ?3 AND ${SEALED_BY_ME}`).bind(id, token, rev, at)] : [])
        : [db.prepare(`INSERT OR IGNORE INTO cost_catalog (catalog_rev, captured_at, source, status, reject_reasons, table_counts, vendor_counts, vendor_total, meta)
              SELECT ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11 WHERE ${SEALED_BY_ME}`).bind(id, token, rev, at, meta.source, status, JSON.stringify(validation.reasons),
                JSON.stringify(counts.tableCounts), JSON.stringify(counts.vendorCounts), counts.vendorTotal, JSON.stringify({ builtAt: meta.builtAt, commit: meta.commit })),
           ...(validation.accepted ? [db.prepare(`INSERT OR IGNORE INTO cost_catalog_part (catalog_rev, table_name, part, payload)
              SELECT ?3, table_name, part, payload FROM catalog_upload_part WHERE upload_id = ?1 AND ${SEALED_BY_ME}
                AND EXISTS (SELECT 1 FROM cost_catalog WHERE catalog_rev = ?3 AND status = 'accepted')`).bind(id, token, rev)] : [])]),
      db.prepare(`INSERT INTO ingest_run (run_id, source, week_start, started_at, finished_at, status, rows_seen, rows_written, duplicates, diagnostics, weeks_touched)
          SELECT ?3, 'catalog', NULL, ?4, ?4, 'ok', 1, ?5, ?6, ?7, '{}' WHERE ${SEALED_BY_ME}`).bind(id, token, runId, at, exists ? 0 : 1, exists ? 1 : 0, JSON.stringify(diagnostics)),
      ...refreshStmts,
      db.prepare(`DELETE FROM catalog_upload_part WHERE upload_id = ?1 AND ${SEALED_BY_ME}`).bind(id, token),
      ...STORED(db).map(s => s.bind(id)),
    ]);
    if (res[0].meta?.changes !== 1) {
      const now = await db.prepare('SELECT status, result FROM catalog_upload WHERE upload_id = ?1').bind(id).first();
      if (now?.status === 'sealed' && now.result) return json(publicAnswer(answerFrom(JSON.parse(now.result), await db.batch(STORED(db).map(s => s.bind(id))), true)));
      throw new ApiError(409, 'seal_conflict', 'The chunks changed while sealing; nothing was stored. Seal again (or re-upload)');
    }
    return json(publicAnswer(answerFrom(planned, res.slice(-3))));
  } catch (e) {
    await reopen();
    throw e;
  }
}
