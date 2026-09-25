/**
 * db.js — D1 helpers.
 *
 * D1 limits bound parameters per statement (100) and queries per Worker
 * invocation (50 on the free plan). Bulk writes therefore go through SQLite's
 * json_each(): a whole batch of rows travels as ONE bound JSON parameter, so an
 * ingest call costs a fixed handful of statements no matter how many rows it
 * carries. Each statement's JSON is chunked to stay well under D1's row/string
 * size limit.
 */
import { DEFAULT_SETTINGS } from '../../shared/gate.js';

export const nowIso = () => new Date().toISOString();
export const newId = prefix => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;

const MAX_JSON_CHARS = 800_000;

/** Split rows so each JSON array stays under the size cap. */
export function chunkRows(rows) {
  const chunks = []; let cur = [], size = 2;
  for (const r of rows) {
    const s = JSON.stringify(r).length + 1;
    if (cur.length && size + s > MAX_JSON_CHARS) { chunks.push(cur); cur = []; size = 2; }
    cur.push(r); size += s;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/**
 * INSERT (OR REPLACE) many rows with one bound parameter per chunk.
 * `columns` are the table's column names; each row is an object with those keys.
 */
export function jsonInsert(db, table, columns, rows, { replace = true } = {}) {
  if (!rows.length) return [];
  const select = columns.map(c => `json_extract(value, '$.${c}')`).join(', ');
  const sql = `INSERT ${replace ? 'OR REPLACE ' : ''}INTO ${table} (${columns.join(', ')}) SELECT ${select} FROM json_each(?1)`;
  return chunkRows(rows).map(chunk => db.prepare(sql).bind(JSON.stringify(chunk.map(r => {
    const o = {}; for (const c of columns) o[c] = r[c] === undefined ? null : (typeof r[c] === 'boolean' ? (r[c] ? 1 : 0) : r[c]);
    return o;
  }))));
}

/** DELETE rows whose key column is in a list, one statement per chunk. */
export function jsonDeleteIn(db, table, column, values) {
  if (!values.length) return [];
  return chunkRows(values).map(chunk =>
    db.prepare(`DELETE FROM ${table} WHERE ${column} IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(chunk)));
}

/** SELECT … WHERE column IN (list), chunked; returns all rows. */
export async function selectIn(db, sqlWithPlaceholder, values) {
  const out = [];
  for (const chunk of chunkRows(values)) {
    const r = await db.prepare(sqlWithPlaceholder).bind(JSON.stringify(chunk)).all();
    out.push(...(r.results || []));
  }
  return out;
}

/** Run statements atomically. D1's batch() is a single transaction. */
export async function atomic(db, statements) {
  if (!statements.length) return [];
  return db.batch(statements);
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export async function getSettings(db) {
  const r = await db.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULT_SETTINGS };
  for (const row of r.results || []) { try { s[row.key] = JSON.parse(row.value); } catch { s[row.key] = row.value; } }
  return s;
}

export const SETTABLE_KEYS = new Set([
  'ss_coverage_threshold', 'catalog_shrink_tolerance', 'publication_enabled',
  'carrier_fee_priority_locked', 'insurance_treatment', 'store_timezone',
  'store_timezone_confirmed', 'schedule_timezone', 'schedule_weekday', 'schedule_time',
  'shipping_report_currency', 'shipping_report_timezone', 'shipping_report_store', 'shipping_cost_report_source_verified',
]);

/** Changing these needs a stated reason; every change is audited either way. */
export const REASON_REQUIRED = new Set(['publication_enabled', 'carrier_fee_priority_locked', 'store_timezone',
  'store_timezone_confirmed', 'schedule_timezone', 'schedule_weekday', 'schedule_time', 'ss_coverage_threshold',
  'shipping_report_currency', 'shipping_report_timezone', 'shipping_report_store', 'shipping_cost_report_source_verified']);

/** Changing one of these clears shipping_cost_report_source_verified (reconciliation must be repeated). */
export const CLEARS_SHIPPING_VERIFICATION = new Set(['shipping_report_currency', 'shipping_report_timezone', 'shipping_report_store']);

const validZone = z => { try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch { return false; } };

export function validateSetting(key, value) {
  if (!SETTABLE_KEYS.has(key)) return `unknown setting ${key}`;
  if (key === 'ss_coverage_threshold' && !(typeof value === 'number' && value > 0 && value <= 1)) return 'ss_coverage_threshold must be a number in (0, 1]';
  if (key === 'catalog_shrink_tolerance' && !(typeof value === 'number' && value >= 0 && value < 1)) return 'catalog_shrink_tolerance must be a number in [0, 1)';
  if (['publication_enabled', 'carrier_fee_priority_locked', 'store_timezone_confirmed'].includes(key) && typeof value !== 'boolean') return `${key} must be true or false`;
  if ((key === 'store_timezone' || key === 'schedule_timezone') && !(typeof value === 'string' && validZone(value))) return `${key} must be an IANA time zone`;
  if (key === 'schedule_weekday' && !(Number.isInteger(value) && value >= 0 && value <= 6)) return 'schedule_weekday must be 0 (Sunday) to 6';
  if (key === 'schedule_time' && !(typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value))) return 'schedule_time must be HH:MM (24-hour)';
  // Revision 5: Insurance Cost is not added until the non-duplication test is
  // complete. Until then the setting cannot be changed through the API.
  if (key === 'shipping_report_currency' && !(typeof value === 'string' && /^[A-Z]{3}$/.test(value))) return 'shipping_report_currency must be a 3-letter ISO code';
  if (key === 'shipping_report_timezone' && !(typeof value === 'string' && validZone(value))) return 'shipping_report_timezone must be an IANA time zone';
  if (key === 'shipping_report_store' && !(typeof value === 'string' && value.trim() && value.length <= 80)) return 'shipping_report_store must be a non-empty store name';
  if (key === 'shipping_cost_report_source_verified' && value !== false) return 'shipping_cost_report_source_verified can only be set true through the verification checklist (not available before C3)';
  if (key === 'insurance_treatment' && value !== 'awaiting_confirmation') return 'insurance_treatment is locked at awaiting_confirmation until the Insurance Cost non-duplication test is complete';
  return null;
}
