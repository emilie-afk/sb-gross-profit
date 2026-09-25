/**
 * lib.mjs — pure helpers for the ShipStation export job (no Playwright import,
 * so they are tested in the main suite).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Last completed Monday–Sunday week in the store's time zone. Scheduled at
 * Monday 08:05 UTC (15:05 Ho Chi Minh), which is after the Los Angeles week
 * closes in both seasons (07:00 UTC in PDT, 08:00 UTC in PST).
 */
export function lastCompletedWeek(now = new Date(), timeZone = 'America/Los_Angeles') {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const [y, m, d] = ymd.split('-').map(Number);
  const today = new Date(Date.UTC(y, m - 1, d));
  const dow = today.getUTCDay();                               // 0 = Sunday
  const thisMonday = new Date(today); thisMonday.setUTCDate(today.getUTCDate() - ((dow + 6) % 7));
  const start = new Date(thisMonday); start.setUTCDate(thisMonday.getUTCDate() - 7);
  const end = new Date(thisMonday); end.setUTCDate(thisMonday.getUTCDate() - 1);
  const iso = x => x.toISOString().slice(0, 10);
  const us = x => `${String(x.getUTCMonth() + 1).padStart(2, '0')}/${String(x.getUTCDate()).padStart(2, '0')}/${x.getUTCFullYear()}`;
  return { weekStart: iso(start), weekEnd: iso(end), weekStartUS: us(start), weekEndUS: us(end) };
}

/** The Monday–Sunday week starting on a given Monday (YYYY-MM-DD). */
export function weekFromStart(weekStart) {
  const m = String(weekStart).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error('--week must be YYYY-MM-DD');
  const start = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (start.getUTCDay() !== 1) throw new Error('--week must be a Monday');
  const end = new Date(start); end.setUTCDate(start.getUTCDate() + 6);
  const iso = x => x.toISOString().slice(0, 10);
  const us = x => `${String(x.getUTCMonth() + 1).padStart(2, '0')}/${String(x.getUTCDate()).padStart(2, '0')}/${x.getUTCFullYear()}`;
  return { weekStart: iso(start), weekEnd: iso(end), weekStartUS: us(start), weekEndUS: us(end) };
}

/** Replace {{name}} placeholders in export-step values. Unknown names are an error, not a blank. */
export function render(template, vars) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`Unknown placeholder {{${k}}} in export steps`);
    return String(vars[k]);
  });
}

/**
 * Header names that indicate customer data. The approved export template has
 * none; a file that carries any is refused before it reaches Google Drive.
 */
const CUSTOMER_HEADER = /(recipient|ship\s*to|buyer|customer|address|street|city|postal|zip|phone|e-?mail|company)/i;
const ALLOWED_LOOKALIKES = new Set(['store name', 'provider name', 'created by', 'user name', 'item name']);

export function customerHeaders(headers) {
  return headers.filter(h => CUSTOMER_HEADER.test(h) && !ALLOWED_LOOKALIKES.has(String(h).trim().toLowerCase()));
}

/** First CSV line → header names (quoted fields supported). */
export function csvHeaderNames(text) {
  const line = String(text).split(/\r?\n/, 1)[0] || '';
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === ',' && !q) { out.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

export const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

/** Local folders outside the repository: browser profile, run manifests. */
export function localPaths(config = {}) {
  const base = config.localDir || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'sb-shipstation-export');
  return { base, profile: path.join(base, 'profile'), runs: path.join(base, 'runs'), downloads: path.join(base, 'downloads'),
           quarantine: path.join(base, 'quarantine') };
}

/** Columns the saved "SB GP weekly" template must have for the export to be usable. */
export const REQUIRED_EXPORT_HEADERS = Object.freeze(['Shipment ID', 'Order Number', 'Item SKU']);

/** Why an export is unusable, or null. An empty week is reported, not uploaded. */
export function invalidExportReason(headers, rowCount) {
  const have = new Set(headers.map(h => String(h).trim()));
  const missing = REQUIRED_EXPORT_HEADERS.filter(h => !have.has(h));
  if (missing.length) return `missing columns: ${missing.join(', ')}`;
  if (!have.has('Carrier Fee') && !have.has('Rate')) return 'missing columns: Carrier Fee and Rate';
  if (!(rowCount > 0)) return 'no shipment rows';
  return null;
}

/** Delete files in `dir` older than `maxAgeMs` (quarantine retention). */
export function purgeOlderThan(dir, maxAgeMs, now = Date.now()) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isFile() && now - st.mtimeMs > maxAgeMs) { fs.rmSync(p); n++; }
  }
  return n;
}

/** Refuse config values that look like secrets: the config file must never hold them. */
export function assertNoSecretsInConfig(config) {
  const bad = [];
  const SECRET_KEY = /^(password|passcode|pass|pwd|otp|2fa|mfa|code|token|accesstoken|cookie|cookies|secret|session|sessionid|storagestate)$/i;
  const walk = (v, p) => {
    if (SECRET_KEY.test(p.split('.').pop())) { bad.push(p); return; }   // objects too: storageState: {…}
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`);
  };
  walk(config, '$');
  if (bad.length) throw new Error(`Config must not contain credentials: ${bad.join(', ')}. Use the Windows Credential Manager.`);
}
