#!/usr/bin/env node
/**
 * Tracked-file privacy and secret scan (C8).
 *
 *   node tools/secret-scan.mjs [--denylist <private file>] [--history]
 *
 * Scans every file `git ls-files` lists (or, with --history, every blob ever
 * committed on HEAD's history) for secret-shaped strings, private keys,
 * spreadsheet addresses, real-looking email addresses and phone numbers,
 * and committed data exports. `--denylist` points at a PRIVATE text file
 * (outside the repository) with one sensitive literal per line — for example
 * the Products Master id, tab gids, or customer names and emails from a real
 * export. Only a hash prefix of each hit is printed, never the value, and
 * a finding is reported as file + rule + count.
 * Exit code 1 when anything is found.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 30 });
const h8 = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);

// Synthetic / documentation values that are allowed on purpose.
// Reserved / documentation domains (RFC 2606 / 6761), the Shopify sender shape the
// Gmail matcher is tested against, and 555-01xx fictional phone numbers.
const ALLOWED_EMAIL = /(\.invalid|\.example|@example\.(com|org|net)|users\.noreply\.github\.com|@anthropic\.com|@shopify\.com|@admin\.shopify\.com|\.evil\.io)$/i;
const ALLOWED_PHONE = /555[ .-]?01\d/;
const RULES = [
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['github_token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g],
  ['google_api_key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['google_oauth_secret', /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/g],
  ['google_refresh_token', /\b1\/\/0[A-Za-z0-9_-]{30,}\b/g],
  ['slack_token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ['aws_key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['cloudflare_token', /\b[A-Za-z0-9_-]{40}\b(?=.*(CLOUDFLARE|CF_API))/g],
  ['bearer', /\bBearer\s+[A-Za-z0-9._-]{24,}/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ['sheet_address', /docs\.google\.com\/spreadsheets\/d\/(?!<)[A-Za-z0-9_-]{20,}/g],
  ['drive_folder', /drive\.google\.com\/drive\/folders\/(?!<)[A-Za-z0-9_-]{20,}/g],
  ['netlify_hook', /api\.netlify\.com\/build_hooks\/(?!<)[0-9a-f]{20,}/g],
  ['d1_database_id', /database_id\s*=\s*"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/g],
  ['secret_assignment', /\b(INGEST_SECRET|ADMIN_SECRET|SESSION_SIGNING_KEY|SB_INGEST_SECRET|GDRIVE_API_KEY)\s*[=:]\s*["']?[A-Za-z0-9+/_=-]{24,}/g],
  ['phone', /(?<![\d.])(?:\+1[ .-]?)?\(?[2-9]\d{2}\)?[ .-]\d{3}[ .-]\d{4}(?!\d)/g],
];
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const DATA_FILE = /\.(csv|zip|xlsx|xls|sqlite|db|dump|sql\.gz)$/i;
const ALLOWED_DATA = new Set([]);                                  // no committed data exports are expected

const args = process.argv.slice(2);
const denyPath = args.includes('--denylist') ? args[args.indexOf('--denylist') + 1] : null;
const deny = denyPath ? fs.readFileSync(denyPath, 'utf8').split('\n').map(s => s.trim()).filter(s => s.length >= 4) : [];
if (denyPath && path.resolve(denyPath).startsWith(ROOT + path.sep)) { console.error('The denylist must live outside the repository'); process.exit(2); }

let blobs;
if (args.includes('--history')) {
  const seen = new Set(); blobs = [];
  for (const line of git('rev-list', '--objects', 'HEAD').split('\n')) {
    const [sha, ...p] = line.split(' '); const file = p.join(' ');
    if (!file || seen.has(sha)) continue;
    let type; try { type = git('cat-file', '-t', sha).trim(); } catch { continue; }
    if (type !== 'blob') continue;
    seen.add(sha); blobs.push({ file, read: () => git('cat-file', '-p', sha) });
  }
} else {
  blobs = git('ls-files', '-z').split('\0').filter(Boolean).map(f => ({ file: f, read: () => fs.readFileSync(path.join(ROOT, f), 'latin1') }));
}

const findings = [];
let scanned = 0;
for (const b of blobs) {
  if (DATA_FILE.test(b.file) && !ALLOWED_DATA.has(b.file)) findings.push({ file: b.file, rule: 'data_export_committed', count: 1 });
  let text; try { text = b.read(); } catch { continue; }
  if (/\.(png|jpe?g|gif|ico|woff2?|pdf)$/i.test(b.file)) continue;
  scanned++;
  for (const [rule, re] of RULES) {
    let m = text.match(re);
    if (m && rule === 'phone') m = m.filter(x => !ALLOWED_PHONE.test(x));
    if (m?.length) findings.push({ file: b.file, rule, count: m.length, sample: h8(m[0]) });
  }
  const emails = (text.match(EMAIL) || []).filter(e => !ALLOWED_EMAIL.test(e) && !/\.(png|js|mjs|css|svg)$/i.test(e));
  if (emails.length) findings.push({ file: b.file, rule: 'email_address', count: emails.length, sample: h8(emails[0]) });
  for (const d of deny) {
    const n = text.split(d).length - 1;
    if (n) findings.push({ file: b.file, rule: 'denylisted_literal', count: n, sample: h8(d) });
  }
}
const mode = args.includes('--history') ? 'history blobs' : 'tracked files';
console.log(`secret-scan: ${scanned} ${mode} scanned; denylist entries ${deny.length}; findings ${findings.length}`);
for (const f of findings) console.log(`  ${f.rule.padEnd(22)} ${f.file} ×${f.count}${f.sample ? ` [sha256:${f.sample}]` : ''}`);
process.exitCode = findings.length ? 1 : 0;
