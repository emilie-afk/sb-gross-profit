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
  noPii(JSON.stringify([miss, out, src]), 'refusals');
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
async function run(opts) {
  const dir = tmpDir(), config = baseConfig(dir), paths = localPaths(config), f = fakes(opts);
  const m = await runCollector({ config, week, paths, runId: 'shx_test', ...f });
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
  assert.deepEqual([zip.m.status, zip.m.format], ['unknown_export_format', 'zip']);
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
