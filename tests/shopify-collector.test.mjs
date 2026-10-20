/**
 * C5 — Shopify orders collector (Windows host). Synthetic data only; no
 * network, no Playwright: the browser, Gmail and the Worker upload are fakes
 * or the in-process Worker.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/src/index.js';
import { makeEnv, admin } from '../worker/test/helpers.mjs';
import { toCsvText } from '../shared/adapters/shopifyCsv.js';
import { csvOrder } from './fixtures-normalized.mjs';
import {
  rollingWindow, gmailSearchQuery, GMAIL_FIXED_QUERY, GMAIL_SCOPE, extractDownloadLinks, selectExportMessage, detectExportFormat,
  prepareShopifyExport, assertCollectorConfig, localPaths, safeError, EXIT, hostAllowed,
} from '../automation/shopify-export/src/lib.mjs';
import { assertReadonlyScope, gmailAccessToken, gmailClient, decodeBodies } from '../automation/shopify-export/src/gmail.mjs';
import { runCollector } from '../automation/shopify-export/src/collect.mjs';
import { uploadToWorker } from '../automation/shipstation-export/src/upload.mjs';
import { uploadCorporateOrders, corporateIngestEndpoint, CORPORATE_MAX_BYTES } from '../automation/shopify-export/src/corporateUpload.mjs';
import { registerSecret } from '../automation/shipstation-export/src/redact.mjs';
import crypto from 'node:crypto';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const week = { weekStart: '2026-09-14', weekEnd: '2026-09-20', weekStartUS: '09/14/2026', weekEndUS: '09/20/2026' };
const PII = ['synthetic.buyer@example.invalid', 'SYNTHETIC BUYER', '1 Synthetic Way', '+1 555 010 0000', 'gift note for synthetic', 'utm_source=synthetic', 'tok_synthetic_123'];
const LINK = 'https://admin.shopify.com/store/synthetic/exports/abc123/download?sig=xyz';

/** A raw Shopify admin export: customer columns and raw free text included. */
function rawExportRows({ source = 'web', dates = ['2026-09-15 10:00:00 -0700', '2026-08-02 09:00:00 -0700'] } = {}) {
  const rows = [
    ...csvOrder({ name: '#920001', createdAt: dates[0], subtotal: 20, shipping: 5, total: 25, source,
      tags: 'influencer, synthetic.buyer@example.invalid', noteAttributes: 'Channel: web\nutm: https://x.example/?utm_source=synthetic\ncart_token: tok_synthetic_123',
      lines: [{ sku: 'MG-ALOE', price: 10, qty: 2, vendor: 'Succulents Box' }] }),
    ...csvOrder({ name: '#920002', createdAt: dates[1], subtotal: 45, shipping: 9, total: 54, refunded: 10, source,
      lines: [{ sku: 'FH-POTHOS', price: 45, qty: 1, vendor: 'House Plant Dropship' }] }),
  ];
  return rows.map(r => ({ 'Name': r['Name'], 'Email': PII[0], ...r, 'Fulfilled at': '', 'Billing Name': PII[1], 'Shipping Address1': PII[2],
    'Phone': PII[3], 'Notes': PII[4], 'Discount Code': 'SYNTH-INFLUENCER-2026' }));
}
const rawCsv = opts => { const rows = rawExportRows(opts); return toCsvText(rows, Object.keys(rows[0])); };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sb-shx-'));
const baseConfig = (dir) => ({ adminUrl: 'https://admin.shopify.com/store/synthetic', localDir: dir, workerUrl: 'https://worker.example',
  gmail: { mailbox: 'exports@example.invalid', pollSeconds: 60, timeoutMinutes: 10 },
  exportSteps: [{ action: 'goto', url: 'https://admin.shopify.com/store/synthetic/orders' }, { action: 'requestExport', selector: '#export' }] });
const noPii = (s, where) => { for (const p of PII) assert.ok(!String(s).includes(p), `${p} found in ${where}`); };
const allFiles = dir => fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(f => path.join(dir, String(f))).filter(f => fs.statSync(f).isFile()) : [];

// ─── Pure helpers ─────────────────────────────────────────────────────────────

test('C5 Shopify: the rolling window is the eight weeks ending on the reporting Sunday', () => {
  assert.deepEqual(rollingWindow(week), { from: '2026-07-27', to: '2026-09-20', fromUS: '07/27/2026', toUS: '09/20/2026' });
});

test('C5 Shopify: the Gmail search is a fixed constant plus a numeric time bound', () => {
  const q = gmailSearchQuery('2026-09-21T08:05:00Z');
  assert.equal(q, `${GMAIL_FIXED_QUERY} after:${Math.floor((Date.parse('2026-09-21T08:05:00Z') - 5 * 60_000) / 1000)}`);
  assert.match(q, /^from:shopify\.com subject:export after:\d+$/);
  assert.throws(() => gmailSearchQuery('yesterday'), /ISO/);
});

test('C5 Shopify: config cannot carry a Gmail search, secrets or a non-Admin URL', () => {
  const dir = tmpDir();
  assert.deepEqual(assertCollectorConfig(baseConfig(dir)), { pollSeconds: 60, timeoutMinutes: 10 });
  const c = extra => ({ ...baseConfig(dir), ...extra });
  assert.throws(() => assertCollectorConfig(c({ gmail: { ...baseConfig(dir).gmail, query: 'in:anywhere' } })), /fixed in code/);
  assert.throws(() => assertCollectorConfig(c({ extra: { search: 'x' } })), /fixed in code/);
  assert.throws(() => assertCollectorConfig(c({ gmail: { ...baseConfig(dir).gmail, labelIds: ['INBOX'] } })), /Unknown gmail setting/);
  assert.throws(() => assertCollectorConfig(c({ password: 'x' })), /credentials/);
  assert.throws(() => assertCollectorConfig(c({ gmail: { ...baseConfig(dir).gmail, refreshToken: 'x' } })), /Unknown gmail setting|credentials/);
  assert.throws(() => assertCollectorConfig(c({ adminUrl: 'https://evil.example/admin' })), /adminUrl must be/);
  assert.throws(() => assertCollectorConfig(c({ gmail: { ...baseConfig(dir).gmail, timeoutMinutes: 999 } })), /timeoutMinutes/);
  // The shipped example is valid once the placeholders are filled in.
  const ex = JSON.parse(fs.readFileSync(path.join(REPO, 'automation/shopify-export/config.example.json'), 'utf8'));
  assert.doesNotThrow(() => assertCollectorConfig({ ...ex, adminUrl: 'https://admin.shopify.com/store/synthetic', localDir: dir,
    gmail: { ...ex.gmail, mailbox: 'exports@example.invalid' } }));
  assert.ok(ex.exportSteps.some(s => s.action === 'requestExport'));
});

test('C5 Shopify: local folders must be outside the repository and cloud-synced folders', () => {
  assert.throws(() => localPaths({ localDir: path.join(REPO, 'tmp') }), /outside the repository/);
  assert.throws(() => localPaths({ localDir: 'C:\\Users\\x\\OneDrive\\sb' }), /cloud-synced/);
  const p = localPaths({ localDir: tmpDir() });
  assert.deepEqual(Object.keys(p), ['base', 'profile', 'runs', 'downloads', 'quarantine']);
});

test('C5 Shopify: only https export links on Shopify-owned hosts are accepted', () => {
  const html = `<a href="${LINK.replace(/&/g, '&amp;')}">Download</a> <a href="https://evil.example/export.csv">x</a>
    <a href="https://admin.shopify.com.evil.io/export">y</a> <a href="http://admin.shopify.com/export">z</a>
    <a href="https://help.shopify.com/manual/orders">help</a> https://u:p@admin.shopify.com/export`;
  assert.deepEqual(extractDownloadLinks(html), [LINK]);
  assert.equal(hostAllowed('shop-1.myshopify.com'), true);
  assert.equal(hostAllowed('myshopify.com.attacker.net'), false);
});

test('C5 Shopify: exactly one matching email after the request is required', () => {
  const at = '2026-09-21T08:05:00Z', t = Date.parse(at);
  const m = (o = {}) => ({ id: 'm1', internalDate: t + 60_000, from: 'Shopify <mailer@shopify.com>', subject: 'Your orders export is ready', links: [LINK], ...o });
  assert.equal(selectExportMessage([], { requestedAt: at }).status, 'waiting');
  assert.equal(selectExportMessage([m({ internalDate: t - 3600_000 })], { requestedAt: at }).status, 'waiting', 'older than the request');
  assert.equal(selectExportMessage([m({ from: 'Someone <x@shopify.com.evil.io>' })], { requestedAt: at }).status, 'waiting', 'lookalike sender');
  assert.equal(selectExportMessage([m({ subject: 'Your products export is ready' })], { requestedAt: at }).status, 'waiting', 'not an orders export');
  assert.equal(selectExportMessage([m({ links: [] })], { requestedAt: at }).status, 'waiting');
  const f = selectExportMessage([m()], { requestedAt: at });
  assert.deepEqual([f.status, f.link], ['found', LINK]);
  assert.deepEqual(selectExportMessage([m(), m({ id: 'm2' })], { requestedAt: at }), { status: 'ambiguous', count: 2 });
});

test('C5 Shopify: only a Shopify orders CSV is accepted as the download', () => {
  assert.equal(detectExportFormat(Buffer.from(rawCsv())), 'shopify_orders_csv');
  assert.equal(detectExportFormat(Buffer.from('\uFEFF' + rawCsv())), 'shopify_orders_csv');
  assert.equal(detectExportFormat(Buffer.from('<!DOCTYPE html><html>Log in</html>')), 'html');
  assert.equal(detectExportFormat(Buffer.from('Name,Email\n'), 'text/html; charset=utf-8'), 'html');
  assert.equal(detectExportFormat(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2])), 'zip');
  assert.equal(detectExportFormat(Buffer.from('Handle,Title\n')), 'unknown');
  assert.equal(detectExportFormat(Buffer.alloc(0)), 'empty');
});

test('C5 Shopify: the export is sanitized before upload — no customer data or raw free text leaves the machine', () => {
  const p = prepareShopifyExport(rawCsv(), { week, exportedAt: '2026-09-21T08:30:00Z' });
  assert.ok(!p.refused, JSON.stringify(p));
  noPii(p.sanitizedText, 'sanitized text');
  noPii(JSON.stringify(p.facts), 'facts');
  assert.ok(!p.sanitizedText.includes('SYNTH-INFLUENCER-2026'), 'raw discount code');
  assert.deepEqual(p.facts.droppedColumns.sort(), ['Billing Name', 'Email', 'Notes', 'Phone', 'Shipping Address1']);
  assert.deepEqual([p.payload.mode, p.payload.format, p.payload.weekStart, p.facts.orderCount, p.facts.firstOrderDate, p.facts.lastOrderDate],
    ['rolling', 'csv_text', '2026-09-14', 2, '2026-08-02', '2026-09-15']);
  assert.match(p.sanitizedText, /influencer/, 'the engine still sees the influencer tag');
});

test('C5 Shopify: unknown formats, missing columns, wrong windows and unapproved text are refused', () => {
  const x = (t, o = {}) => prepareShopifyExport(t, { week, exportedAt: 'x', ...o });
  assert.equal(x('Handle,Title\nh,t\n').refused, 'unknown_export_format');
  assert.equal(x('').refused, 'no_orders');
  const rows = rawExportRows().map(({ 'Fulfilled at': _f, ...r }) => r);
  const miss = x(toCsvText(rows, Object.keys(rows[0])));
  assert.deepEqual([miss.refused, miss.detail.missing], ['missing_columns', ['Fulfilled at']]);
  const out = x(rawCsv({ dates: ['2026-09-15 10:00:00 -0700', '2026-07-20 09:00:00 -0700'] }));
  assert.deepEqual([out.refused, out.detail.outside], ['export_window_mismatch', 1]);
  const src = x(rawCsv({ source: 'synthetic-new-app' }));
  assert.equal(src.refused, 'sanitization_failed');
  assert.deepEqual(src.detail.problems, { 'Source: unapproved source value': 2 });
  assert.deepEqual(src.detail.newSources, { 'synthetic-new-app': 2 }, 'an identifier-shaped Source is named so the list can be extended');
  noPii(JSON.stringify([miss, out, src]), 'refusals');
  // Once approved, the same kind of order passes (Faire wholesale, Oct 2026).
  const faire = x(rawCsv({ source: 'faire' }));
  assert.equal(faire.refused, undefined, JSON.stringify(faire.detail || {}));
  // Source text that is not an identifier is still refused without being named.
  for (const v of ['Jane Doe', 'jane@example.invalid', '5551234567', 'https://x.example']) {
    const r = x(rawCsv({ source: v }));
    assert.equal(r.refused, 'sanitization_failed');
    assert.equal(r.detail.newSources, undefined, v);
    assert.ok(!JSON.stringify(r).includes(v), `${v} never appears in the refusal`);
  }
});

test('Shopify: an order created the morning after the window is kept and counted; other strays still refuse', () => {
  const x = (t, o = {}) => prepareShopifyExport(t, { week, exportedAt: 'x', ...o });
  const csv = rawCsv({ dates: ['2026-09-21 00:10:10 -0700', '2026-08-02 09:00:00 -0700'] });
  const spill = x(csv);
  assert.equal(spill.refused, undefined);
  assert.deepEqual([spill.facts.orderCount, spill.facts.keptAfterWindow, spill.facts.lastOrderDate], [2, 1, '2026-09-21']);
  // Shopify's next export does not repeat such an order, so it must be uploaded here.
  assert.ok(spill.payload.text.includes('#920001') && spill.payload.text.includes('#920002'));
  for (const d of ['2026-09-22 00:10:00 -0700', '2026-07-26 23:50:00 -0700']) {
    const r = x(rawCsv({ dates: [d, '2026-08-02 09:00:00 -0700'] }));
    assert.deepEqual([r.refused, r.detail.outside], ['export_window_mismatch', 1], d);
  }
  noPii(JSON.stringify(spill.facts), 'facts');
});

test('C5 Shopify: errors in a manifest never carry a URL or an e-mail address', () => {
  assert.equal(safeError(new Error(`net::ERR at ${LINK} for a@b.example`)), 'net::ERR at <url> for <email>');
});

// ─── Gmail read-only client ───────────────────────────────────────────────────

test('C5 Gmail: the token must carry gmail.readonly and nothing else', async () => {
  assert.doesNotThrow(() => assertReadonlyScope(GMAIL_SCOPE));
  for (const bad of ['', 'https://mail.google.com/', `${GMAIL_SCOPE} https://www.googleapis.com/auth/gmail.modify`]) {
    assert.throws(() => assertReadonlyScope(bad), e => e.code === 'gmail_scope_not_readonly');
  }
  const tokenFetch = scope => async (url, init) => {
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    assert.match(String(init.body), /grant_type=refresh_token/);
    return new Response(JSON.stringify({ access_token: 'at-synthetic', scope }), { status: 200 });
  };
  assert.equal(await gmailAccessToken({ clientId: 'c', clientSecret: 's', refreshToken: 'r', fetchImpl: tokenFetch(GMAIL_SCOPE) }), 'at-synthetic');
  await assert.rejects(gmailAccessToken({ clientId: 'c', clientSecret: 's', refreshToken: 'r', fetchImpl: tokenFetch('https://mail.google.com/') }),
    e => e.code === 'gmail_scope_not_readonly');
  await assert.rejects(gmailAccessToken({ clientId: 'c', clientSecret: 's', refreshToken: '' }), e => e.code === 'gmail_auth_missing');
});

test('C5 Gmail: only GET profile, the fixed search and one message read; the body stays inside', async () => {
  const calls = [];
  const html = Buffer.from(`<p>${PII[4]}</p><a href="${LINK}">Download orders export</a>`).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  const fetchImpl = async (url, init) => {
    calls.push([init.method, url, init.headers.Authorization]);
    if (url.endsWith('/profile')) return new Response(JSON.stringify({ emailAddress: 'Exports@Example.invalid' }));
    if (url.includes('/messages?q=')) return new Response(JSON.stringify({ messages: [{ id: 'abcdef123' }] }));
    return new Response(JSON.stringify({ id: 'abcdef123', internalDate: '1790000000000', payload: { mimeType: 'multipart/alternative',
      headers: [{ name: 'From', value: 'Shopify <mailer@shopify.com>' }, { name: 'Subject', value: 'Your orders export is ready' }],
      parts: [{ mimeType: 'text/html', body: { data: html } }, { mimeType: 'text/csv', filename: 'x.csv', body: { attachmentId: 'A' } }] } }));
  };
  const g = gmailClient({ accessToken: 'at-synthetic', fetchImpl });
  assert.equal(await g.mailbox(), 'exports@example.invalid');
  assert.deepEqual(await g.searchExportMessages('2026-09-21T08:05:00Z'), ['abcdef123']);
  const m = await g.readExportMessage('abcdef123');
  assert.deepEqual(Object.keys(m).sort(), ['from', 'id', 'internalDate', 'links', 'subject']);
  assert.deepEqual(m.links, [LINK]);
  noPii(JSON.stringify(m), 'message result');
  assert.ok(calls.every(c => c[0] === 'GET' && c[2] === 'Bearer at-synthetic'));
  const q = new URL(calls[1][1]).searchParams.get('q');
  assert.equal(q, gmailSearchQuery('2026-09-21T08:05:00Z'));
  await assert.rejects(g.readExportMessage('../labels'), e => e.code === 'gmail_call_not_allowed');
  assert.match(decodeBodies({ mimeType: 'text/plain', body: { data: Buffer.from('hi').toString('base64') } }), /hi/);
});

// ─── The whole run, with fakes ────────────────────────────────────────────────

function fakes({ auth = ['authenticated'], mailbox = 'exports@example.invalid', emails = [[], ['m1']], message = {}, download,
                 direct = null, uploadOk = true } = {}) {
  const log = { steps: 0, searches: 0, uploads: [], logins: 0, opened: false, fetched: [] };
  const states = [...auth];
  const t0 = Date.parse('2026-09-21T08:05:00Z');
  let clock = t0;
  const polls = [...emails];
  return {
    log,
    now: () => new Date(clock),
    sleep: async ms => { clock += ms; },
    gmailClient: async () => ({
      mailbox: async () => mailbox,
      searchExportMessages: async () => { log.searches++; return polls.length > 1 ? polls.shift() : polls[0]; },
      readExportMessage: async id => ({ id, internalDate: clock, from: 'Shopify <mailer@shopify.com>', subject: 'Your orders export is ready', links: [LINK], ...message }),
    }),
    browser: {
      open: async () => { log.opened = true; },
      authState: async () => ({ state: states.length > 1 ? states.shift() : states[0], evidence: null }),
      login: async () => { log.logins++; },
      runSteps: async () => { log.steps++; return { download: direct }; },
      fetchDownload: async url => { log.fetched.push(url); return download || { status: 200, contentType: 'text/csv', body: Buffer.from(rawCsv()), finalHost: 'storage.example' }; },
      close: async () => {},
    },
    credential: () => ({ username: 'staff@example.invalid', password: 'synthetic-password' }),
    upload: async payload => { log.uploads.push(payload); return uploadOk ? { ok: true, httpStatus: 200, sourceStatus: 'source_received', runId: 'ing_x' } : { ok: false, httpStatus: 503, error: 'http_503' }; },
  };
}
async function run(opts, extra = {}) {
  const dir = tmpDir(), config = baseConfig(dir), paths = localPaths(config), f = fakes(opts);
  const m = await runCollector({ config, week, paths, runId: 'shx_test', ...f, ...extra });
  const manifestText = fs.readFileSync(path.join(paths.runs, 'shx_test.json'), 'utf8');
  return { m, f, paths, manifestText };
}

test('C5 collector: happy path — email link, sanitized upload, manifest with hashes and counts only', async () => {
  const { m, f, paths, manifestText } = await run();
  assert.deepEqual([m.status, m.exitCode], ['ok', EXIT.OK]);
  assert.equal(f.log.searches, 2, 'polled until the email arrived');
  assert.deepEqual(f.log.fetched, [LINK]);
  assert.equal(f.log.uploads.length, 1);
  noPii(f.log.uploads[0].text, 'uploaded text');
  assert.equal(f.log.uploads[0].mode, 'rolling');
  assert.deepEqual([m.facts.rowCount, m.facts.orderCount, m.mailboxVerified, m.downloadHost, m.download.format],
    [2, 2, true, 'admin.shopify.com', 'shopify_orders_csv']);
  noPii(manifestText, 'manifest');
  for (const forbidden of [LINK, 'sig=xyz', 'Your orders export', 'mailer@shopify.com', 'm1', 'synthetic-password', 'exports@example.invalid']) {
    assert.ok(!manifestText.includes(forbidden), `${forbidden} in manifest`);
  }
  assert.deepEqual(allFiles(paths.downloads).concat(allFiles(paths.quarantine)), [], 'nothing but the manifest on disk');
});

test('C5 collector: a zipped export (Shopify emails large exports as a ZIP) is unzipped in memory and handled like the CSV', async () => {
  const { default: zlib } = await import('node:zlib');
  const data = Buffer.from(rawCsv()), comp = zlib.deflateRawSync(data), nm = Buffer.from('orders_export_1.csv'), crc = zlib.crc32(data);
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
  const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + nm.length, 12); end.writeUInt32LE(30 + nm.length + comp.length, 16);
  const body = Buffer.concat([lh, nm, comp, ch, nm, end]);
  const { m, f, paths } = await run({ download: { status: 200, contentType: 'application/zip', body, finalHost: 'storage.example' } });
  assert.deepEqual([m.status, m.download.format, m.download.unzippedBytes, m.facts.orderCount, f.log.uploads.length], ['ok', 'zip', data.length, 2, 1]);
  assert.ok(body.every(x => x === 0), 'the zipped raw bytes are zeroed');
  assert.deepEqual(allFiles(paths.downloads).concat(allFiles(paths.quarantine)), [], 'nothing on disk');
});

test('C5 collector: a small export that downloads directly skips the email wait', async () => {
  const { m, f } = await run({ direct: Buffer.from(rawCsv()) });
  assert.deepEqual([m.status, m.download.via, f.log.searches, f.log.fetched.length], ['ok', 'direct_download', 0, 0]);
});

test('C5 collector: 2FA, captcha, unknown pages and rejected logins stop before any export step', async () => {
  for (const [auth, status, code] of [[['two_factor_required'], 'needs_2fa', EXIT.NEEDS_2FA], [['captcha'], 'needs_human_captcha', EXIT.CAPTCHA],
    [['unknown'], 'unknown_page', EXIT.UNKNOWN_PAGE], [['login_required', 'login_required'], 'login_failed', EXIT.LOGIN_FAILED],
    [['login_required', 'two_factor_required'], 'needs_2fa', EXIT.NEEDS_2FA]]) {
    const { m, f } = await run({ auth });
    assert.deepEqual([m.status, m.exitCode, f.log.steps, f.log.uploads.length], [status, code, 0, 0], auth.join('>'));
  }
  const ok = await run({ auth: ['login_required', 'authenticated'] });
  assert.deepEqual([ok.m.status, ok.f.log.logins], ['ok', 1]);
});

test('C5 collector: the wrong mailbox stops before Shopify is opened', async () => {
  const { m, f } = await run({ mailbox: 'someone-else@example.invalid' });
  assert.deepEqual([m.status, m.exitCode, f.log.opened], ['gmail_mailbox_mismatch', EXIT.GMAIL_AUTH, false]);
});

test('C5 collector: no email, two emails, a login page or an unknown file stop the run', async () => {
  const timeout = await run({ emails: [[]] });
  assert.deepEqual([timeout.m.status, timeout.m.exitCode], ['export_email_timeout', EXIT.EMAIL_TIMEOUT]);
  const two = await run({ emails: [['m1', 'm2']] });
  assert.deepEqual([two.m.status, two.m.candidates, two.f.log.fetched.length], ['export_email_ambiguous', 2, 0]);
  const login = await run({ download: { status: 200, contentType: 'text/html', body: Buffer.from('<html>Log in</html>') } });
  assert.equal(login.m.status, 'download_requires_login');
  const zip = await run({ download: { status: 200, contentType: 'application/zip', body: Buffer.from([0x50, 0x4b, 0x03, 0x04]) } });
  assert.deepEqual([zip.m.status, zip.m.format], ['unknown_export_format', 'zip_unreadable'], 'a zip that is not exactly one readable CSV');
  const http = await run({ download: { status: 403, contentType: 'text/plain', body: Buffer.from('no') } });
  assert.deepEqual([http.m.status, http.m.httpStatus], ['download_failed', 403]);
  for (const r of [timeout, two, login, zip, http]) assert.equal(r.f.log.uploads.length, 0);
});

test('C5 collector: a refused export uploads nothing and keeps nothing', async () => {
  const bad = rawExportRows({ source: 'synthetic-new-app' });
  const { m, f, paths, manifestText } = await run({ download: { status: 200, contentType: 'text/csv', body: Buffer.from(toCsvText(bad, Object.keys(bad[0]))) } });
  assert.deepEqual([m.status, m.exitCode, f.log.uploads.length], ['sanitization_failed', EXIT.EXPORT_FAILED, 0]);
  noPii(manifestText, 'manifest');
  assert.deepEqual(allFiles(paths.downloads).concat(allFiles(paths.quarantine)), []);
});

test('C5 collector: an upload failure quarantines only the sanitized file', async () => {
  const { m, paths } = await run({ uploadOk: false });
  assert.deepEqual([m.status, m.exitCode], ['upload_failed', EXIT.UPLOAD_FAILED]);
  const q = allFiles(paths.quarantine);
  assert.equal(q.length, 1);
  noPii(fs.readFileSync(q[0], 'utf8'), 'quarantined file');
});

// ─── End to end with the in-process Worker ────────────────────────────────────

test('C5 end to end: sanitized rolling upload → week and updated-order runs; re-sending is source_no_change', async () => {
  const env = await makeEnv();
  const viaWorker = async (url, init) => worker.fetch(new Request(url, init), env);
  const p = prepareShopifyExport(rawCsv(), { week, exportedAt: '2026-09-21T08:30:00Z' });
  const up = payload => uploadToWorker({ workerUrl: 'https://worker.example', ingestSecret: env.INGEST_SECRET, path: p.path, payload, fetchImpl: viaWorker, sleep: async () => {} });
  const a = await up(p.payload);
  assert.deepEqual([a.ok, a.sourceStatus], [true, 'source_received']);
  const r = (await admin(env, 'GET', `/v1/admin/readiness?weekStart=${week.weekStart}`)).json;
  assert.deepEqual([r.sources.shopify.status, r.sources.shopify_updates.status], ['ok', 'ok']);
  assert.ok(r.missing.includes('shipping_cost_report:missing'));
  const b = await up(p.payload);
  assert.deepEqual([b.ok, b.sourceStatus, b.rowsWritten], [true, 'source_no_change', 0]);
  const dump = JSON.stringify((await env.DB.prepare('SELECT * FROM shopify_order').all()).results)
    + JSON.stringify((await env.DB.prepare('SELECT * FROM shopify_order_line').all()).results);
  noPii(dump, 'D1');
});

test('collector: Shopify sign-in that needs a person — a visible run waits in the open window and continues the export once signed in', async () => {
  const calls = [];
  const hooks = { signInWaitMinutes: 30, signInPollSeconds: 10, onSignInRequired: async x => { calls.push(['required', x.state, x.waitMinutes]); },
                  onSignedIn: async () => { calls.push(['signed_in']); } };
  const runWith = async (auth, extra = {}) => {
    const dir = tmpDir(), config = baseConfig(dir), paths = localPaths(config), f = fakes({ auth });
    let gotoAdmin = 0;
    f.browser.gotoAdmin = async () => { gotoAdmin++; };
    const m = await runCollector({ config, week, paths, runId: 'shx_test', ...f, ...hooks, ...extra });
    return { m, f, gotoAdmin, manifest: fs.readFileSync(path.join(paths.runs, 'shx_test.json'), 'utf8') };
  };
  // Signed in after a few polls: the same run requests the export and uploads it.
  const ok = await runWith(['login_required', 'two_factor_required', 'two_factor_required', 'two_factor_required', 'authenticated']);
  assert.deepEqual([ok.m.status, ok.m.exitCode, ok.f.log.logins, ok.f.log.steps, ok.f.log.uploads.length], ['ok', EXIT.OK, 1, 1, 1]);
  assert.deepEqual(calls, [['required', 'two_factor_required', 30], ['signed_in']]);
  assert.equal(ok.m.signIn.needed, 'two_factor_required');
  assert.ok(ok.m.signIn.completedAt && ok.m.signIn.waitedMinutes >= 0);
  assert.ok(!ok.manifest.includes('synthetic-password'));
  // Shopify lands outside Admin after the code: after a minute there the run goes back to Admin.
  calls.length = 0;
  const away = await runWith(['two_factor_required', ...Array(7).fill('unknown'), 'authenticated']);
  assert.deepEqual([away.m.status, away.gotoAdmin >= 1], ['ok', true]);
  // Nobody signs in: the wait ends after signInWaitMinutes, nothing is requested, and the run says why.
  calls.length = 0;
  const no = await runWith(['two_factor_required']);
  assert.deepEqual([no.m.status, no.m.exitCode, no.f.log.steps, no.f.log.uploads.length], ['needs_2fa', EXIT.NEEDS_2FA, 0, 0]);
  assert.equal(no.m.signIn.waitedMinutes, 30);
  assert.deepEqual(calls, [['required', 'two_factor_required', 30]]);
  // A human check is waited for the same way; a headless run (wait 0) still stops at once.
  const cap = await runWith(['captcha', 'authenticated']);
  assert.equal(cap.m.status, 'ok');
  calls.length = 0;
  const headless = await runWith(['two_factor_required'], { signInWaitMinutes: 0 });
  assert.deepEqual([headless.m.status, calls.length], ['needs_2fa', 0]);
});

// ─── Corporate gifting orders (sbcg-orders-v1), independent of GP ────────────

const CORP_URL = 'https://corp.example/api/ingest/shopify-orders';
const CORP_COUNTS = { status: 'completed', received: 2, new: 2, updated: 0, unchanged: 0, stale: 0, rejected: 0, warnings: 0 };
const csvBody = rows => ({ status: 200, contentType: 'text/csv', body: Buffer.from(toCsvText(rows, Object.keys(rows[0]))), finalHost: 'storage.example' });
/** A fake corporateUpload that records each body and how many GP uploads had happened when it was called. */
function corpFake(result = { ok: true, httpStatus: 200, counts: CORP_COUNTS }, gpLog = null) {
  const sent = [];
  const fn = async body => { sent.push({ body, gpUploadsBefore: gpLog ? gpLog.uploads.length : null }); return typeof result === 'function' ? result() : result; };
  return { sent, fn };
}

test('corporate: the copied corporateOrders.mjs is the unchanged sb-corporate-gifts module', () => {
  const b = fs.readFileSync(path.join(REPO, 'automation/shopify-export/src/corporateOrders.mjs'));
  assert.equal(crypto.createHash('sha256').update(b).digest('hex'), '836a5bb2ab41bd2c3188f57df9cd50bd76eebb86e376a566c402f190a766fa55');
});

test('corporate: the same export is reduced to sbcg-orders-v1 and sent once, after the GP upload; no personal data', async () => {
  const dir = tmpDir(), config = baseConfig(dir), paths = localPaths(config), fk = fakes();
  const corp = corpFake(undefined, fk.log);
  const m2 = await runCollector({ config, week, paths, runId: 'shx_test', ...fk, corporateUpload: corp.fn });
  const text2 = fs.readFileSync(path.join(paths.runs, 'shx_test.json'), 'utf8');
  assert.deepEqual([m2.status, m2.exitCode, fk.log.uploads.length, corp.sent.length, corp.sent[0].gpUploadsBefore], ['ok', EXIT.OK, 1, 1, 1]);
  const p = JSON.parse(corp.sent[0].body);
  assert.deepEqual([p.format, p.store, p.exportedAt, p.coverageFrom, p.coverageTo], ['sbcg-orders-v1', 'succulentsbox', m2.exportedAt, '2026-07-27', '2026-09-20']);
  assert.deepEqual(p.orders.map(o => o.name).sort(), ['#920001', '#920002']);
  assert.deepEqual(p.orders.find(o => o.name === '#920001').tags, ['influencer'], 'a personal-looking tag is dropped');
  noPii(corp.sent[0].body, 'corporate payload');
  assert.ok(!corp.sent[0].body.includes('SYNTH-INFLUENCER-2026'), 'discount code');
  assert.deepEqual(m2.corporate, { status: 'sent', httpStatus: 200, orders: 2, counts: CORP_COUNTS });
  noPii(text2, 'manifest');
  assert.ok(!text2.includes('#920001'), 'no order in the manifest');
});

test('corporate: an upload failure, a 401 or a throw never changes the GP status or exit code', async () => {
  const outcomes = [['http_503', { ok: false, httpStatus: 503 }], ['http_401', { ok: false, httpStatus: 401 }],
    ['throw', () => { throw new Error('No stored credential named sb-corporate-ingest'); }]];
  for (const uploadOk of [true, false]) {
    const base = await run({ uploadOk });
    for (const [label, result] of outcomes) {
      const corp = corpFake(result);
      const { m } = await run({ uploadOk }, { corporateUpload: corp.fn });
      assert.deepEqual([m.status, m.exitCode, m.quarantined ?? null], [base.m.status, base.m.exitCode, base.m.quarantined ?? null], `${label}, GP upload ok=${uploadOk}`);
      assert.equal(m.corporate.status, 'upload_failed', label);
      assert.equal(corp.sent.length, 1);
    }
  }
});

test('corporate: a GP refusal for an unapproved Source still sends the corporate payload; a window mismatch does not', async () => {
  const bad = rawExportRows({ source: 'synthetic-new-app' });
  const base = await run({ download: csvBody(bad) });
  const corp = corpFake();
  const { m, f } = await run({ download: csvBody(bad) }, { corporateUpload: corp.fn });
  assert.deepEqual([m.status, m.exitCode, m.reason, f.log.uploads.length], [base.m.status, base.m.exitCode, base.m.reason, 0]);
  assert.equal(m.status, 'sanitization_failed');
  assert.equal(corp.sent.length, 1);
  assert.ok(JSON.parse(corp.sent[0].body).orders.every(o => o.source === 'synthetic-new-app'));
  assert.equal(m.corporate.status, 'sent');
  // The export does not match the window it would claim: nothing is sent to the app.
  const out = rawExportRows({ dates: ['2026-09-15 10:00:00 -0700', '2026-07-20 09:00:00 -0700'] });
  const corp2 = corpFake();
  const w = await run({ download: csvBody(out) }, { corporateUpload: corp2.fn });
  assert.deepEqual([w.m.status, w.m.exitCode, corp2.sent.length, w.m.corporate.status], ['export_window_mismatch', EXIT.EXPORT_FAILED, 0, 'refused:gp_export_window_mismatch']);
});

test('corporate: not configured → no corporate call and skipped_not_configured; a stop before the download records nothing', async () => {
  const { m } = await run();
  assert.deepEqual([m.status, m.corporate], ['ok', { status: 'skipped_not_configured' }]);
  const corp = corpFake();
  const early = await run({ auth: ['two_factor_required'] }, { corporateUpload: corp.fn });
  assert.deepEqual([early.m.status, early.m.corporate, corp.sent.length], ['needs_2fa', undefined, 0]);
});

test('corporate: the raw buffer is still zeroed and the secret never reaches the manifest or run record', async () => {
  const secret = 'corp-secret-synthetic-0123456789abcdef';
  const raw = Buffer.from(rawCsv());
  const corp = corpFake(() => { registerSecret(secret); throw new Error(`401 for Bearer ${secret}`); });
  const { m, manifestText } = await run({ direct: raw }, { corporateUpload: corp.fn });
  assert.equal(m.status, 'ok');
  assert.ok(raw.every(x => x === 0), 'raw export zeroed');
  assert.equal(m.corporate.status, 'upload_failed');
  assert.ok(!JSON.stringify(m).includes(secret) && !manifestText.includes(secret), 'secret in the manifest');
  assert.ok(!corp.sent[0].body.includes(secret));
});

test('corporate: sent at most once even when two finishing paths are reached', async () => {
  // The run record cannot be written the first time: the 'ok' finish throws, the catch path finishes again.
  const dir = tmpDir(), config = baseConfig(dir), paths = localPaths(config), fk = fakes();
  const corp = corpFake();
  let runsFailures = 1;
  const fsRunsFailsOnce = { ...fs, mkdirSync: (p, ...a) => { if (p === paths.runs && runsFailures-- > 0) throw new Error('disk busy'); return fs.mkdirSync(p, ...a); } };
  const m = await runCollector({ config, week, paths, runId: 'shx_test', ...fk, fs: fsRunsFailsOnce, corporateUpload: corp.fn });
  assert.deepEqual([m.status, m.exitCode, fk.log.uploads.length, corp.sent.length, m.corporate.status], ['export_failed', EXIT.EXPORT_FAILED, 1, 1, 'sent']);
});

test('corporate: a payload over the app limit is not sent', async () => {
  const rows = [];
  const long = 'Synthetic plant ' + 'x'.repeat(1500);
  for (let i = 0; i < 4200; i++) rows.push(...csvOrder({ name: `#93${String(i).padStart(4, '0')}`, createdAt: '2026-09-15 10:00:00 -0700', subtotal: 10, total: 10,
    lines: [{ sku: 'MG-ALOE', name: long, price: 10, qty: 1, vendor: 'Succulents Box' }] }));
  const full = rows.map(r => ({ 'Name': r['Name'], ...r, 'Fulfilled at': '' }));
  const corp = corpFake();
  const { m } = await run({ direct: Buffer.from(toCsvText(full, Object.keys(full[0]))) }, { corporateUpload: corp.fn });
  assert.equal(corp.sent.length, 0);
  assert.equal(m.corporate.status, 'refused:too_large');
  assert.ok(CORPORATE_MAX_BYTES <= 6 * 1024 * 1024);
});

test('corporate: config accepts only an https …/api/ingest/shopify-orders URL', () => {
  const dir = tmpDir();
  const c = extra => ({ ...baseConfig(dir), ...extra });
  assert.doesNotThrow(() => assertCollectorConfig(c({ corporateIngestUrl: null })));
  assert.doesNotThrow(() => assertCollectorConfig(c({ corporateIngestUrl: 'https://sb-corporate-gifts.netlify.app/api/ingest/shopify-orders', corporateIngestCredentialTarget: 'sb-corporate-ingest' })));
  for (const bad of ['http://sb-corporate-gifts.netlify.app/api/ingest/shopify-orders', 'https://sb-corporate-gifts.netlify.app/api/ingest/orders',
    'https://sb-corporate-gifts.netlify.app/api/ingest/shopify-orders?x=1', 'https://u:p@corp.example/api/ingest/shopify-orders', 'not a url']) {
    assert.throws(() => assertCollectorConfig(c({ corporateIngestUrl: bad })), /corporateIngestUrl must be/, bad);
  }
  assert.throws(() => assertCollectorConfig(c({ corporateIngestCredentialTarget: 'bad target;' })), /corporateIngestCredentialTarget/);
  const ex = JSON.parse(fs.readFileSync(path.join(REPO, 'automation/shopify-export/config.example.json'), 'utf8'));
  assert.deepEqual([ex.corporateIngestUrl, ex.corporateIngestCredentialTarget], [null, 'sb-corporate-ingest']);
});

test('corporate upload: bearer POST, retries only network errors and 5xx, keeps counts only', async () => {
  const secret = 'corp-secret-synthetic-abcdef0123456789';
  const calls = [];
  const fetchFrom = answers => async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.Authorization, redirect: init.redirect, hasSignal: !!init.signal });
    const a = answers.shift();
    if (a === 'net') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(a.json ?? {}), { status: a.status });
  };
  const up = (answers, o = {}) => uploadCorporateOrders({ url: CORP_URL, secret, body: '{}', fetchImpl: fetchFrom(answers), sleep: async () => {}, ...o });

  const ok = await up([{ status: 200, json: { ok: true, ...CORP_COUNTS, warnings: ['w1', 'w2'], import_id: 'imp_x', detail: 'synthetic.buyer@example.invalid' } }]);
  assert.deepEqual(ok, { ok: true, httpStatus: 200, attempts: 1, counts: { ...CORP_COUNTS, warnings: 2 } });
  assert.deepEqual(calls[0], { url: CORP_URL, method: 'POST', auth: `Bearer ${secret}`, redirect: 'error', hasSignal: true });

  calls.length = 0;
  const retried = await up(['net', { status: 502 }, { status: 200, json: { status: 'duplicate', received: 2 } }]);
  assert.deepEqual([retried.ok, retried.attempts, retried.counts], [true, 3, { status: 'duplicate', received: 2 }]);

  calls.length = 0;
  const gaveUp = await up([{ status: 503 }, { status: 503 }, { status: 503 }, { status: 200 }]);
  assert.deepEqual([gaveUp.ok, gaveUp.httpStatus, gaveUp.attempts, calls.length], [false, 503, 3, 3]);

  for (const status of [400, 401, 413, 429]) {
    calls.length = 0;
    const r = await up([{ status, json: { error: 'payload_rejected', paths: ['orders[0].tags[0]'] } }, { status: 200 }]);
    assert.deepEqual([r.ok, r.httpStatus, r.attempts, calls.length, r.error], [false, status, 1, 1, `http_${status}`], `no retry on ${status}`);
    assert.ok(!JSON.stringify(r).includes('payload_rejected'), 'no response body kept');
  }
  assert.ok(!JSON.stringify([ok, retried, gaveUp]).includes(secret));
  await assert.rejects(uploadCorporateOrders({ url: 'http://corp.example/api/ingest/shopify-orders', secret, body: '{}' }), /corporateIngestUrl must be/);
  await assert.rejects(uploadCorporateOrders({ url: CORP_URL, secret: '', body: '{}' }), /Missing corporate ingest secret/);
  assert.equal(corporateIngestEndpoint('https://sb-corporate-gifts.netlify.app/api/ingest/shopify-orders'), 'https://sb-corporate-gifts.netlify.app/api/ingest/shopify-orders');
});
