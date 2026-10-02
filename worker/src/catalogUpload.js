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
 */
import { ApiError, json, readJson } from './http.js';
import { newId, nowIso, getSettings, atomic } from './db.js';
import { latestAcceptedCatalogMeta } from './store.js';
import { withRun, resolveRefresh } from './ingest.js';
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
  await db.prepare(`INSERT INTO catalog_upload_part (upload_id, table_name, part, grp, first_key, last_key, n, sha256, payload) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
      ON CONFLICT(upload_id, table_name, part) DO UPDATE SET grp = excluded.grp, first_key = excluded.first_key, last_key = excluded.last_key, n = excluded.n, sha256 = excluded.sha256, payload = excluded.payload`)
    .bind(id, table, part, pos.key, keys[0] ?? null, keys[keys.length - 1] ?? null, keys.length, await sha256Text(payload), payload).run();
  return json({ uploadId: id, table, part, entries: keys.length });
}

export async function sealCatalogUpload(request, env, id) {
  const db = env.DB;
  const u = await openUpload(db, id);
  const layout = P(u.layout, []), meta = P(u.meta, {});
  const rows = (await db.prepare('SELECT table_name, part, grp, first_key, last_key, n, sha256 FROM catalog_upload_part WHERE upload_id = ?1').bind(id).all()).results || [];
  const byTable = new Map();
  for (const r of rows) (byTable.get(r.table_name) || byTable.set(r.table_name, []).get(r.table_name)).push(r);
  // Completeness and key order (keys strictly increase across the chunks of a table or group).
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
  const counts = { tableCounts, vendorCounts, vendorTotal: Object.values(vendorCounts).reduce((s, n) => s + n, 0) };
  const rev = await catalogPartsRevFromHashes(rows.map(r => [r.table_name, r.part, r.sha256]));
  const body = { meta: { source: meta.source, builtAt: meta.builtAt, commit: meta.commit, refreshId: meta.refreshId } };
  return withRun(env, 'catalog', body, async () => {
    const settings = await getSettings(db);
    const prev = await latestAcceptedCatalogMeta(db);
    const previous = prev ? { tableCounts: JSON.parse(prev.table_counts), vendorCounts: JSON.parse(prev.vendor_counts) } : null;
    const validation = validateCatalogCounts(counts, previous, { shrinkTolerance: Number(settings.catalog_shrink_tolerance) });
    const exists = await db.prepare('SELECT status FROM cost_catalog WHERE catalog_rev = ?1').bind(rev).first();
    const at = nowIso();
    const done = [db.prepare('DELETE FROM catalog_upload_part WHERE upload_id = ?1').bind(id),
                  db.prepare("UPDATE catalog_upload SET status = 'sealed', sealed_at = ?2 WHERE upload_id = ?1 AND status = 'open'").bind(id, at)];
    if (exists) {
      // Same content pushed again: it is the current catalog again (as the one-request push).
      await atomic(db, [...(exists.status === 'accepted' ? [db.prepare('UPDATE cost_catalog SET last_pushed_at = ?2 WHERE catalog_rev = ?1').bind(rev, at)] : []), ...done]);
    } else {
      await atomic(db, [
        db.prepare(`INSERT INTO cost_catalog (catalog_rev, captured_at, source, status, reject_reasons, table_counts, vendor_counts, vendor_total, meta)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`).bind(rev, at, meta.source, validation.accepted ? 'accepted' : 'rejected', JSON.stringify(validation.reasons),
            JSON.stringify(counts.tableCounts), JSON.stringify(counts.vendorCounts), counts.vendorTotal, JSON.stringify({ builtAt: meta.builtAt, commit: meta.commit })),
        // The fragments move into the catalog inside D1: the Worker never re-reads the catalog.
        ...(validation.accepted ? [db.prepare('INSERT INTO cost_catalog_part (catalog_rev, table_name, part, payload) SELECT ?2, table_name, part, payload FROM catalog_upload_part WHERE upload_id = ?1').bind(id, rev)] : []),
        ...done,
      ]);
    }
    const accepted = exists ? exists.status === 'accepted' : validation.accepted;
    const refresh = await resolveRefresh(db, meta.refreshId, { rev, accepted, reasons: validation.reasons });
    return { rowsSeen: 1, written: exists ? 0 : 1, duplicates: exists ? 1 : 0,
             diagnostics: { catalogRev: rev, accepted, reasons: validation.reasons, refresh },
             response: { catalogRev: rev, accepted, status: exists ? exists.status : (validation.accepted ? 'accepted' : 'rejected'), reasons: validation.reasons, refresh,
                         counts, activeCatalogRev: accepted ? rev : (prev?.catalog_rev || null) } };
  });
}
