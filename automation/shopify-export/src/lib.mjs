/**
 * lib.mjs — pure helpers for the Shopify orders collector (C5)
 * ============================================================
 * No Playwright and no network here, so everything is tested in the main suite.
 *
 * The collector (export.mjs) asks Shopify Admin for the rolling eight-week
 * orders export, reads the "export ready" email from the export mailbox with
 * Gmail read-only access and a FIXED search, downloads the file into memory,
 * sanitizes it at once and uploads only the sanitized CSV to the Worker.
 *
 * Privacy rules this file enforces:
 *   • the Gmail search is a constant plus a numeric time bound; config cannot
 *     supply or extend it;
 *   • only links on Shopify-owned hosts are accepted, and the link, the email
 *     body and the raw export are never returned in facts or written anywhere;
 *   • the raw export is reduced to the approved columns and minimum free-text
 *     form (shared/adapters/shopifyCsv.js + shopifyPrivacy.js) and re-checked
 *     with the Worker's own validators before upload;
 *   • refusals name columns, rules and counts, never values.
 */
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { parseCSV } from '../../../shared/calculator.js';
import { addDays } from '../../../shared/normalized.js';
import {
  prepareShopifyUpload, assertSanitizedShopifyOrderRows, currenciesOf, SHOPIFY_ORDERS_CSV_REQUIRED,
} from '../../../shared/adapters/shopifyCsv.js';
import { assertReducedShopifyOrderRows } from '../../../shared/adapters/shopifyPrivacy.js';
import { assertSafeLocalDir, assertNoSecretsInConfig } from '../../shipstation-export/src/lib.mjs';

export const KIND = 'shopify_orders_export';
export const INGEST_PATH = '/v1/ingest/shopify';
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const RETENTION_MS = 72 * 3600_000;

/** Process exit codes (shared meaning with the ShipStation job where they overlap). */
export const EXIT = Object.freeze({
  OK: 0, CONFIG: 10, NEEDS_2FA: 20, CAPTCHA: 21, UNKNOWN_PAGE: 22, LOGIN_FAILED: 23, GMAIL_AUTH: 24,
  EXPORT_FAILED: 30, UPLOAD_FAILED: 31, EMAIL_TIMEOUT: 32,
});

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const us = iso => { const [y, m, d] = iso.split('-'); return `${m}/${d}/${y}`; };

/** Rolling eight-week window of order dates ending on the reporting week's Sunday. */
export function rollingWindow(week) {
  if (!week?.weekEnd || !/^\d{4}-\d{2}-\d{2}$/.test(week.weekEnd)) throw new Error('week.weekEnd must be YYYY-MM-DD');
  const from = addDays(week.weekEnd, -55), to = week.weekEnd;
  return { from, to, fromUS: us(from), toUS: us(to) };
}

// ─── Gmail: fixed search ──────────────────────────────────────────────────────

/** The only Gmail search this collector ever runs. Not configurable. */
export const GMAIL_FIXED_QUERY = 'from:shopify.com subject:export';
/** Messages received more than this long before the export request are ignored. */
export const EMAIL_CLOCK_SKEW_MS = 5 * 60_000;

/** Fixed query + a numeric lower time bound (seconds since epoch). */
export function gmailSearchQuery(requestedAtIso) {
  const ms = Date.parse(requestedAtIso);
  if (!Number.isFinite(ms)) throw new Error('requestedAt must be an ISO timestamp');
  return `${GMAIL_FIXED_QUERY} after:${Math.floor((ms - EMAIL_CLOCK_SKEW_MS) / 1000)}`;
}

/** Shopify-owned hosts a download link may point to. Extending this is a code change. */
export const DOWNLOAD_HOST_SUFFIXES = Object.freeze(['shopify.com', 'myshopify.com', 'shopifycloud.com', 'shopifycdn.com', 'shopifysvc.com']);
export const hostAllowed = host => {
  const h = String(host || '').toLowerCase();
  return DOWNLOAD_HOST_SUFFIXES.some(s => h === s || h.endsWith(`.${s}`));
};
const SENDER_OK = /@([a-z0-9-]+\.)*shopify\.com>?\s*$/i;

const decodeEntities = s => s.replace(/&amp;/gi, '&').replace(/&#x3d;|&#61;/gi, '=').replace(/&quot;/gi, '"');

/**
 * Candidate export-download links in an email body (HTML or text), in memory.
 * Only https links on Shopify-owned hosts whose path or query mention an
 * export or download are returned.
 */
export function extractDownloadLinks(body) {
  const text = decodeEntities(String(body || ''));
  const found = new Set();
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>()]+/gi)) {
    let u; try { u = new URL(m[0].replace(/[.,;]+$/, '')); } catch { continue; }
    if (u.protocol !== 'https:' || u.username || u.password) continue;
    if (!hostAllowed(u.hostname)) continue;
    if (!/(export|download)/i.test(u.pathname + u.search)) continue;
    found.add(u.toString());
  }
  return [...found];
}

/**
 * Choose the export email among messages read since the request.
 * @param {{ id, internalDate: number, from: string, subject: string, links: string[] }[]} messages
 * @returns {{ status: 'found', message, link } | { status: 'waiting' } | { status: 'ambiguous', count }}
 */
export function selectExportMessage(messages, { requestedAt }) {
  const since = Date.parse(requestedAt) - EMAIL_CLOCK_SKEW_MS;
  const ok = (messages || []).filter(m => Number(m.internalDate) >= since && SENDER_OK.test(String(m.from || ''))
    && /export/i.test(String(m.subject || '')) && /order/i.test(String(m.subject || '')) && (m.links || []).length === 1);
  if (!ok.length) return { status: 'waiting' };
  if (ok.length > 1) return { status: 'ambiguous', count: ok.length };
  return { status: 'found', message: ok[0], link: ok[0].links[0] };
}

// ─── Export file ──────────────────────────────────────────────────────────────

/** What the downloaded bytes are. Only a Shopify orders CSV is accepted. */
export function detectExportFormat(buf, contentType = '') {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '');
  if (!b.length) return 'empty';
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'zip';
  const head = b.subarray(0, 1024).toString('utf8').replace(/^﻿/, '');
  if (/html/i.test(contentType) || /^\s*</.test(head) || /<html/i.test(head)) return 'html';
  const first = head.split(/\r?\n/, 1)[0];
  if (/^"?Name"?,/.test(first)) return 'shopify_orders_csv';
  return 'unknown';
}

/** Columns the collector requires beyond the Worker's minimum (C3 evidence and refunds). */
export const COLLECTOR_REQUIRED_COLUMNS = Object.freeze([...SHOPIFY_ORDERS_CSV_REQUIRED, 'Cancelled at', 'Fulfilled at', 'Financial Status']);
const REFUND_COLUMNS = ['Refunded Amount', 'Refunded amount'];

/**
 * Raw export text (in memory) → sanitized upload, or a refusal.
 * @returns {{ refused: string, reason: string, detail? } | { path, payload, sanitizedText, facts }}
 */
export function prepareShopifyExport(text, { week, exportedAt }) {
  const win = rollingWindow(week);
  const raw = String(text || '').replace(/^﻿/, '');
  const rawSha256 = sha(raw);
  let rows;
  try { rows = parseCSV(raw); } catch { return { refused: 'unknown_export_format', reason: 'The file is not a CSV' }; }
  if (!rows.length) return { refused: 'no_orders', reason: 'The export has no order rows' };
  const headers = Object.keys(rows[0]);
  if (headers[0] !== 'Name') return { refused: 'unknown_export_format', reason: 'The first column is not Shopify’s order Name' };
  const missing = COLLECTOR_REQUIRED_COLUMNS.filter(h => !headers.includes(h));
  if (!REFUND_COLUMNS.some(h => headers.includes(h))) missing.push('Refunded Amount');
  if (missing.length) return { refused: 'missing_columns', reason: `Missing columns: ${missing.join(', ')}`, detail: { missing } };

  const prep = prepareShopifyUpload(rows);
  if (prep.problems.length) {
    const byRule = {};
    for (const p of prep.problems) { const k = `${p.column}: ${p.rule}`; byRule[k] = (byRule[k] || 0) + 1; }
    return { refused: 'sanitization_failed', reason: 'Free text outside the approved form', detail: { problems: byRule } };
  }
  // Belt and braces: the Worker's own checks must pass on what would be uploaded.
  let clean;
  try {
    clean = parseCSV(prep.text);
    assertSanitizedShopifyOrderRows(clean);
    assertReducedShopifyOrderRows(clean);
  } catch (e) {
    return { refused: 'sanitization_failed', reason: 'Sanitized rows fail the Worker contract', detail: { code: e.code || e.name, paths: (e.paths || []).length } };
  }

  // The export must be the requested rolling window: every order date inside it.
  const firstRow = new Map();
  for (const r of clean) { const n = String(r['Name'] || '').trim(); if (n && !firstRow.has(n)) firstRow.set(n, r); }
  const dates = [...firstRow.values()].map(r => String(r['Created at'] || '').slice(0, 10));
  const badDates = dates.filter(d => !/^\d{4}-\d{2}-\d{2}$/.test(d)).length;
  const outside = dates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && (d < win.from || d > win.to)).length;
  const sorted = dates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const firstOrderDate = sorted[0] || null, lastOrderDate = sorted[sorted.length - 1] || null;
  if (badDates) return { refused: 'unknown_export_format', reason: `${badDates} order(s) have an unreadable Created at` };
  if (outside) return { refused: 'export_window_mismatch', reason: `${outside} order(s) fall outside ${win.from} → ${win.to}; check the export filter`,
                        detail: { outside, firstOrderDate, lastOrderDate } };

  const sanitizedSha256 = sha(prep.text);
  return {
    path: INGEST_PATH,
    sanitizedText: prep.text,
    payload: { format: 'csv_text', mode: 'rolling', weekStart: week.weekStart, text: prep.text, sanitizedSha256, exportedAt,
               windowFrom: win.from, windowTo: win.to },
    facts: { kind: KIND, rawSha256, sanitizedSha256, rowCount: clean.length, orderCount: firstRow.size, columns: prep.columns,
             droppedColumns: prep.droppedColumns, currencies: currenciesOf(clean), windowFrom: win.from, windowTo: win.to,
             firstOrderDate, lastOrderDate },
  };
}

// ─── Config and local folders ─────────────────────────────────────────────────

const GMAIL_KEYS = new Set(['mailbox', 'credentialTarget', 'clientCredentialTarget', 'pollSeconds', 'timeoutMinutes', '_comment']);
const QUERY_KEY = /^(q|query|search|searchquery|gmailquery|filter)$/i;

/** Validate the collector config: no secrets, no Gmail search, sane bounds. */
export function assertCollectorConfig(config) {
  assertNoSecretsInConfig(config);
  const bad = [];
  const walk = (v, p) => {
    if (QUERY_KEY.test(p.split('.').pop())) bad.push(p);
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`);
  };
  walk(config, '$');
  if (bad.length) throw new Error(`The Gmail search is fixed in code; remove ${bad.join(', ')} from the config`);
  const g = config.gmail || {};
  for (const k of Object.keys(g)) if (!GMAIL_KEYS.has(k)) throw new Error(`Unknown gmail setting ${k}`);
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(String(g.mailbox || ''))) throw new Error('gmail.mailbox must be the export mailbox address');
  const poll = g.pollSeconds ?? 60, timeout = g.timeoutMinutes ?? 45;
  if (!(poll >= 15 && poll <= 600)) throw new Error('gmail.pollSeconds must be between 15 and 600');
  if (!(timeout >= 5 && timeout <= 120)) throw new Error('gmail.timeoutMinutes must be between 5 and 120');
  adminOrigin(config.adminUrl);
  return { pollSeconds: poll, timeoutMinutes: timeout };
}

/** The Shopify Admin origin; export steps may only navigate inside it. */
export function adminOrigin(adminUrl) {
  let u; try { u = new URL(adminUrl); } catch { throw new Error('adminUrl must be the https Shopify Admin URL'); }
  const okHost = u.hostname === 'admin.shopify.com' || u.hostname.endsWith('.myshopify.com');
  if (u.protocol !== 'https:' || !okHost) throw new Error('adminUrl must be https://admin.shopify.com/store/<handle> or https://<shop>.myshopify.com/admin');
  return u.origin;
}

/** Local folders outside the repository and any cloud-synced folder. */
export function localPaths(config = {}) {
  const base = config.localDir || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'sb-shopify-export');
  assertSafeLocalDir(base);
  return { base, profile: path.join(base, 'profile'), runs: path.join(base, 'runs'), downloads: path.join(base, 'downloads'),
           quarantine: path.join(base, 'quarantine') };
}

/** Error text safe for a manifest: no URLs, no e-mail addresses, bounded length. */
export function safeError(e) {
  return String(e?.message || e || 'error')
    .replace(/https?:\/\/\S+/gi, '<url>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .slice(0, 300);
}
