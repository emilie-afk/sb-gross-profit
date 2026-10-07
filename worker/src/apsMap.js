/**
 * apsMap.js — Air Plant Shop scenario input (shared/apsMapping.js), stored apart from results
 * ==========================================================================================
 *   POST /v1/collect/aps-map            (ingest)  one export's mapping: { meta, orders }; pending until every row is stored,
 *                                                 then completed and applied in one transaction; resumable; re-applied when re-received
 *   GET  /v1/collect/aps-map/coverage   (ingest)  which ship dates are covered (the collector's backfill)
 *   GET  /v1/aps/:week                  (reader)  the mapping for orders a week's report can hold; each split order's pins are
 *                                                 checked against the exact Shipping Cost Report rows the week's published
 *                                                 snapshot pinned (snapshotCheck), never against a total
 *
 * Never touches a snapshot, catalog, revision or week status: the financial results are unchanged.
 * Identical content again is `source_no_change` and writes nothing.
 */
import { ApiError, json, readJson, WEEK_RE } from './http.js';
import { newId, nowIso } from './db.js';
import { APS_MAP_SCHEMA, APS_STATUS_TEXT, APS_EXPORT_FORMAT } from '../../shared/apsMapping.js';
import { addDays } from '../../shared/normalized.js';

const MAX_ORDERS = 5000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = new Set(Object.keys(APS_STATUS_TEXT).filter(s => s !== 'not_in_mapping'));
/** Orders of a week ship from the week's Monday; a late label within this many days is still found. */
export const APS_SHIP_LAG_DAYS = 41;

async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const int = v => (Number.isInteger(v) && v >= 0 ? v : 0);

function validate(body) {
  const m = body?.meta, orders = body?.orders;
  if (!m || m.schemaVersion !== APS_MAP_SCHEMA) throw new ApiError(400, 'bad_payload', `meta.schemaVersion must be ${APS_MAP_SCHEMA}`);
  if (!DATE.test(m.window?.from || '') || !DATE.test(m.window?.to || '') || m.window.from > m.window.to) throw new ApiError(400, 'bad_payload', 'meta.window must be { from, to } dates');
  if (!/^[0-9a-f]{64}$/.test(m.source?.sanitizedSha256 || '')) throw new ApiError(400, 'bad_payload', 'meta.source.sanitizedSha256 required');
  if (!Array.isArray(orders) || orders.length > MAX_ORDERS) throw new ApiError(400, 'bad_payload', `orders: an array of at most ${MAX_ORDERS}`);
  const seen = new Set();
  for (const o of orders) {
    if (!/^[0-9A-Z-]{1,24}$/.test(o?.orderKey || '') || seen.has(o.orderKey)) throw new ApiError(400, 'bad_payload', 'each order needs a unique orderKey');
    seen.add(o.orderKey);
    if (!STATUSES.has(o.status)) throw new ApiError(400, 'bad_payload', `unknown status ${String(o.status).slice(0, 40)}`);
    if (o.status === 'split_matched' ? !Number.isInteger(o.apsCostCents) || o.apsCostCents < 0 : o.apsCostCents != null) throw new ApiError(400, 'bad_payload', 'apsCostCents: split_matched only, whole cents');
    if (o.status === 'split_matched' ? !Number.isInteger(o.scrOrderCents) || o.scrOrderCents < o.apsCostCents : o.scrOrderCents != null) throw new ApiError(400, 'bad_payload', 'scrOrderCents: split_matched only, at least the APS cost');
    for (const d of [o.firstShipDate, o.lastShipDate]) if (d != null && !DATE.test(d)) throw new ApiError(400, 'bad_payload', 'ship dates must be YYYY-MM-DD');
    if (o.status === 'split_matched' ? !pinsValid(o) : o.scrPins != null) throw new ApiError(400, 'bad_payload', 'scrPins: split_matched only, one valid pin per ship date adding up to the order\'s costs');
  }
}
const SCR_VERSION = /^scr_[0-9a-f]{20}$/;
const nat = v => Number.isInteger(v) && v >= 0;
/** [[date, labels, cents, apsLabels, apsCents, rowVersion|null]]: dates ascending and distinct; rowVersion exactly on dates holding both kinds. */
function pinsValid(o) {
  const p = o.scrPins;
  if (!Array.isArray(p) || !p.length || p.length > 60) return false;
  let prev = '', cents = 0, aps = 0;
  for (const x of p) {
    if (!Array.isArray(x) || x.length !== 6 || !DATE.test(x[0] || '') || x[0] <= prev) return false;
    const [, labels, c, apsLabels, apsCents, rv] = x;
    if (![labels, c, apsLabels, apsCents].every(nat) || labels < 1 || apsLabels > labels || apsCents > c) return false;
    if (apsLabels === 0 && apsCents !== 0) return false;
    if (apsLabels === labels && apsCents !== c) return false;
    const both = apsLabels > 0 && apsLabels < labels;
    if (both ? !SCR_VERSION.test(rv || '') : rv !== null) return false;
    prev = x[0]; cents += c; aps += apsCents;
  }
  return cents === o.scrOrderCents && aps === o.apsCostCents;
}

const PIN_REASONS = new Set(['rows_not_read', 'rows_unavailable', 'rows_unmatched']);
const ORDER_BATCH = 50;                                    // statements per D1 batch while storing a version's rows

/**
 * Store a version's order rows (pending), then complete it and apply it in ONE batch. A retry of the same
 * content resumes a pending version (rows already stored are kept: INSERT OR IGNORE). Identical content
 * received again with a newer export time is re-applied, so the newest export always decides.
 */
export async function uploadApsMap(request, env) {
  const body = await readJson(request);
  validate(body);
  const { meta, orders } = body;
  const canonical = JSON.stringify({ window: meta.window, orders: orders.map(o => [o.orderKey, o.status, o.apsCostCents ?? null, o.scrOrderCents ?? null, o.firstShipDate ?? null, o.lastShipDate ?? null, o.scrPins ?? null]) });
  const content = await sha256Hex(canonical);
  const db = env.DB;
  const now = nowIso(), exportedAt = typeof meta.source.exportedAt === 'string' ? meta.source.exportedAt.slice(0, 40) : null;
  let v = await db.prepare('SELECT version_id, status, last_exported_at FROM aps_map_version WHERE content_sha256 = ?1').bind(content).first();
  if (v?.status === 'complete') {
    // Same content as a stored export. Re-applied when this export is newer than the classification now active.
    await db.batch([
      db.prepare(`UPDATE aps_map_version SET times_received = times_received + 1,
          last_exported_at = CASE WHEN COALESCE(last_exported_at, '') < COALESCE(?2, '') THEN ?2 ELSE last_exported_at END WHERE version_id = ?1`).bind(v.version_id, exportedAt),
      applyStatement(db, v.version_id, exportedAt),
    ]);
    return json({ sourceStatus: 'source_no_change', versionId: v.version_id, orders: orders.length, reapplied: true });
  }
  const versionId = v?.version_id || newId('apsv');
  if (!v) {
    const counts = { rows: int(meta.rows), duplicateRows: int(meta.duplicateRows), shipments: int(meta.shipments), voidedShipments: int(meta.voidedShipments),
                     apsOrders: orders.length, byStatus: Object.fromEntries(Object.entries(meta.byStatus || {}).filter(([k, n]) => STATUSES.has(k) && Number.isInteger(n))),
                     scrRowsAvailable: !!meta.scrRowsAvailable };
    const scr = meta.scrSource && /^[0-9a-f]{64}$/.test(meta.scrSource.sanitizedSha256 || '') ? meta.scrSource : null;
    await db.prepare(`INSERT INTO aps_map_version (version_id, status, window_from, window_to, exported_at, last_exported_at, received_at, order_count, sanitized_sha256,
        content_sha256, schema_version, template, scr_sha256, scr_from, scr_to, meta) VALUES (?1, 'pending', ?2, ?3, ?4, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`)
      .bind(versionId, meta.window.from, meta.window.to, exportedAt, now, orders.length, meta.source.sanitizedSha256, content, APS_MAP_SCHEMA, APS_EXPORT_FORMAT,
            scr?.sanitizedSha256 || null, DATE.test(scr?.from || '') ? scr.from : null, DATE.test(scr?.to || '') ? scr.to : null, JSON.stringify(counts)).run();
  }
  const rows = orders.map(o => db.prepare(`INSERT OR IGNORE INTO aps_map_order (version_id, order_key, status, aps_cost_cents, scr_order_cents, scr_pins, first_ship_date, last_ship_date, detail)
      VALUES (?1, ?2, ?3, ?4, ?5, ?9, ?6, ?7, ?8)`).bind(versionId, o.orderKey, o.status, o.apsCostCents ?? null, o.scrOrderCents ?? null, o.firstShipDate ?? null, o.lastShipDate ?? null,
      JSON.stringify({ apsShipments: int(o.apsShipments), otherShipments: int(o.otherShipments), mixedShipments: int(o.mixedShipments),
                       noItemShipments: int(o.noItemShipments), apsUnits: int(o.apsUnits), scrCheck: o.scrCheck === 'checked' ? 'checked' : 'not_checked',
                       ...(o.status === 'split_cost_unverified' && PIN_REASONS.has(o.pinReason) ? { pinReason: o.pinReason } : {}) }),
      o.scrPins ? JSON.stringify(o.scrPins) : null));
  for (let i = 0; i < rows.length; i += ORDER_BATCH) await db.batch(rows.slice(i, i + ORDER_BATCH));
  // Complete only when every row is there; completion and activation are one transaction.
  const stored = (await db.prepare('SELECT COUNT(*) AS n FROM aps_map_order WHERE version_id = ?1').bind(versionId).first())?.n || 0;
  if (stored !== orders.length) throw new ApiError(500, 'aps_map_incomplete', 'Not every order row was stored; send the same export again');
  await db.batch([
    db.prepare("UPDATE aps_map_version SET status = 'complete' WHERE version_id = ?1 AND status = 'pending'").bind(versionId),
    applyStatement(db, versionId, exportedAt),
  ]);
  return json({ sourceStatus: v ? 'source_resumed' : 'source_received', versionId, orders: orders.length });
}

/** Apply a complete version's rows to the current mapping; a row is replaced only by an export at least as new. */
function applyStatement(db, versionId, exportedAt) {
  return db.prepare(`INSERT INTO aps_map_active (order_key, version_id, exported_at, status, aps_cost_cents, scr_order_cents, scr_pins, first_ship_date, last_ship_date, detail)
      SELECT o.order_key, o.version_id, ?2, o.status, o.aps_cost_cents, o.scr_order_cents, o.scr_pins, o.first_ship_date, o.last_ship_date, o.detail
      FROM aps_map_order o JOIN aps_map_version v ON v.version_id = o.version_id AND v.status = 'complete' WHERE o.version_id = ?1
      ON CONFLICT (order_key) DO UPDATE SET version_id = excluded.version_id, exported_at = excluded.exported_at, status = excluded.status,
        aps_cost_cents = excluded.aps_cost_cents, scr_order_cents = excluded.scr_order_cents, scr_pins = excluded.scr_pins, first_ship_date = excluded.first_ship_date,
        last_ship_date = excluded.last_ship_date, detail = excluded.detail
      WHERE COALESCE(aps_map_active.exported_at, '') <= COALESCE(excluded.exported_at, '')`).bind(versionId, exportedAt);
}

export async function apsMapCoverage(env) {
  const r = await env.DB.prepare("SELECT MIN(window_from) AS from_, MAX(window_to) AS to_, COUNT(*) AS n FROM aps_map_version WHERE status = 'complete'").first();
  return json({ coveredFrom: r?.from_ || null, coveredTo: r?.to_ || null, versions: r?.n || 0 });
}

/**
 * Check each split order's pins against the Shipping Cost Report rows the week's published snapshot accepted:
 * the manifest it was computed from pins every ship date as [date, owning version, day hash, kept?]; the order's
 * group on each pinned date ([orderKey, cents, rows]) is read from that exact stored day. Verified only when
 *   - the snapshot is a collector-computed one with its manifest (older stored snapshots pin no rows),
 *   - the order belongs to this week's report (otherwise `other_week`: its own week's request decides),
 *   - the pinned dates holding the order are exactly the pins' dates, each with the same cents and row count,
 *   - every date holding APS and other labels was split from the retained rows of exactly the version the
 *     snapshot pinned for it (or, for a cost a later report omitted and the date kept, that cost's source version).
 * Anything else: `unverified` with a reason code; the dashboard then excludes the order (split_cost_unverified).
 */
async function snapshotChecks(db, pub, split) {
  const out = new Map();
  if (!split.length) return out;
  const all = reason => { for (const o of split) out.set(o.orderKey, { status: 'unverified', reason }); return out; };
  if (pub.storage !== 'chunked') return all('snapshot_rows_not_pinned');
  const row = await db.prepare('SELECT manifest FROM result_upload WHERE snapshot_id = ?1').bind(pub.snapshot_id).first();
  let manifest = null;
  try { manifest = JSON.parse(row?.manifest || 'null'); } catch { manifest = null; }
  if (!Array.isArray(manifest?.orders) || !Array.isArray(manifest?.scrDays)) return all('snapshot_manifest_missing');
  const weekKeys = new Set(manifest.orders.map(o => String(o?.[0] ?? '').trim().replace(/^#/, '')));
  const pinned = new Map(manifest.scrDays.map(([d, v, h, kept]) => [d, { v, h, kept: new Map((kept || []).map(([k, kv]) => [k, kv])) }]));
  const mine = split.filter(o => weekKeys.has(o.orderKey));
  for (const o of split) if (!weekKeys.has(o.orderKey)) out.set(o.orderKey, { status: 'other_week' });
  if (!mine.length) return out;
  const keys = await db.prepare('SELECT order_key, version_id, ship_date FROM scr_day_key WHERE order_key IN (SELECT value FROM json_each(?1))')
    .bind(JSON.stringify(mine.map(o => o.orderKey))).all();
  const held = (keys.results || []).filter(r => pinned.get(r.ship_date)?.v === r.version_id);
  const pairs = [...new Map(held.map(r => [`${r.version_id}|${r.ship_date}`, [r.version_id, r.ship_date]])).values()];
  const days = pairs.length ? (await db.prepare(`SELECT d.version_id, d.ship_date, d.day_hash, d.groups FROM scr_day d
      JOIN json_each(?1) j ON d.version_id = json_extract(j.value, '$[0]') AND d.ship_date = json_extract(j.value, '$[1]')`).bind(JSON.stringify(pairs)).all()).results || [] : [];
  const groupsOf = new Map();
  for (const d of days) {
    if (pinned.get(d.ship_date)?.h !== d.day_hash) continue;                         // not the stored day the snapshot pinned
    let g = []; try { g = JSON.parse(d.groups); } catch { g = []; }
    groupsOf.set(d.ship_date, new Map(g.map(x => [x[0], x])));
  }
  for (const o of mine) {
    const pins = o.scrPins || [];
    const dates = held.filter(r => r.order_key === o.orderKey).map(r => r.ship_date).sort();
    let reason = null;
    if (dates.some(d => !groupsOf.has(d))) reason = 'snapshot_day_unreadable';
    else if (dates.join() !== pins.map(p => p[0]).join()) reason = 'ship_dates_differ';
    else for (const [date, labels, cents, apsLabels, , rowVersion] of pins) {
      const g = groupsOf.get(date).get(o.orderKey);
      if (!g || g[1] !== cents || g[2] !== labels) { reason = 'rows_differ'; break; }
      if (apsLabels > 0 && apsLabels < labels) {
        const p = pinned.get(date);
        if (rowVersion !== (p.kept.get(o.orderKey) || p.v)) { reason = 'rows_from_another_report'; break; }
      }
    }
    out.set(o.orderKey, reason ? { status: 'unverified', reason } : { status: 'verified' });
  }
  return out;
}

/** Reader: the versions whose window overlaps the week, and the current mapping of orders shipped from the week on. */
export async function apsForWeek(env, weekStart) {
  if (!WEEK_RE.test(weekStart)) throw new ApiError(400, 'bad_query', 'week must be YYYY-MM-DD');
  // Like every reader route: only weeks with a published revision (never before Aug 3, never a held week).
  const pub = await env.DB.prepare("SELECT snapshot_id, revision, storage FROM snapshot WHERE week_start = ?1 AND status = 'published' ORDER BY revision DESC LIMIT 1").bind(weekStart).first();
  if (!pub) throw new ApiError(404, 'not_published', 'This week has no published report');
  const weekEnd = addDays(weekStart, 6), shipTo = addDays(weekStart, APS_SHIP_LAG_DAYS);
  const [v, o] = await env.DB.batch([
    env.DB.prepare(`SELECT version_id, window_from, window_to, last_exported_at, schema_version, scr_sha256, scr_from, scr_to, meta FROM aps_map_version
        WHERE status = 'complete' AND window_from <= ?2 AND window_to >= ?1 ORDER BY last_exported_at DESC LIMIT 20`).bind(weekStart, weekEnd),
    env.DB.prepare(`SELECT order_key, version_id, exported_at, status, aps_cost_cents, scr_order_cents, scr_pins, first_ship_date, last_ship_date, detail FROM aps_map_active
        WHERE first_ship_date >= ?1 AND first_ship_date <= ?2 ORDER BY first_ship_date LIMIT 2000`).bind(weekStart, shipTo),
  ]);
  const P = s => { try { return JSON.parse(s); } catch { return {}; } };
  const orders = (o.results || []).map(r => ({ orderKey: r.order_key, versionId: r.version_id, exportedAt: r.exported_at, status: r.status,
    apsCostCents: r.aps_cost_cents, scrOrderCents: r.scr_order_cents, scrPins: r.scr_pins ? P(r.scr_pins) : null,
    firstShipDate: r.first_ship_date, lastShipDate: r.last_ship_date, ...P(r.detail) }));
  const checks = await snapshotChecks(env.DB, pub, orders.filter(x => x.status === 'split_matched'));
  for (const x of orders) if (checks.has(x.orderKey)) x.snapshotCheck = checks.get(x.orderKey);
  return json({
    weekStart, shipDatesFrom: weekStart, shipDatesTo: shipTo,
    snapshot: { snapshotId: pub.snapshot_id, revision: pub.revision },
    versions: (v.results || []).map(r => ({ versionId: r.version_id, windowFrom: r.window_from, windowTo: r.window_to, exportedAt: r.last_exported_at,
                                           schemaVersion: r.schema_version, scrSource: r.scr_sha256 ? { from: r.scr_from, to: r.scr_to } : null, counts: P(r.meta) })),
    orders,
  });
}
