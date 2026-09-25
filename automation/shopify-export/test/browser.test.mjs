/**
 * The Playwright adapter against a synthetic, offline Admin (no network, no
 * Shopify): steps stay inside the Admin origin, a direct download is read and
 * its file removed at once, and an emailed link is fetched into memory.
 * Skips when Playwright or Chromium is not installed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { localPaths } from '../src/lib.mjs';

let playwrightBrowser = null;
try { ({ playwrightBrowser } = await import('../src/export.mjs')); } catch { /* playwright not installed */ }

const CSV = 'Name,Created at\n#1,2026-09-15 10:00:00 -0700\n';
const launchOptions = process.env.SB_TEST_CHROMIUM ? { executablePath: process.env.SB_TEST_CHROMIUM } : {};
const ADMIN = '<nav aria-label="Main"><a href="/store/synthetic/orders">Orders</a></nav>'
  + '<button id="export-direct" onclick="location.href=\'/store/synthetic/export.csv\'">Export</button>'
  + '<button id="export-email" onclick="document.body.insertAdjacentHTML(\'beforeend\', \'<p id=done>Emailed</p>\')">Export</button>';

test('Playwright adapter against an offline Admin', { skip: !playwrightBrowser && 'playwright not installed' }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-shx-pw-'));
  const paths = localPaths({ localDir: dir });
  for (const d of Object.values(paths)) fs.mkdirSync(d, { recursive: true });
  const beforeOpen = async context => context.route('https://admin.shopify.com/**', r => r.request().url().endsWith('.csv')
    ? r.fulfill({ status: 200, headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="orders_export.csv"' }, body: CSV })
    : r.fulfill({ status: 200, contentType: 'text/html', body: ADMIN }));
  const b = playwrightBrowser({ config: { adminUrl: 'https://admin.shopify.com/store/synthetic' }, paths, launchOptions, beforeOpen });
  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/csv' }); res.end(CSV); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    try { await b.open(); } catch (e) { t.skip(`chromium unavailable: ${String(e.message).split('\n')[0]}`); return; }
    assert.equal((await b.authState()).state, 'authenticated');
    const steps = [{ _comment: 'documentation only' }, { action: 'goto', url: '/store/synthetic/orders?created={{windowFrom}}' }];
    const direct = await b.runSteps([...steps, { action: 'requestExport', selector: '#export-direct', directDownloadWaitMs: 10000 }], { windowFrom: '2026-07-27' });
    assert.equal(direct.download.toString('utf8'), CSV);
    assert.deepEqual(fs.readdirSync(paths.downloads), [], 'the raw file is removed at once');
    const emailed = await b.runSteps([...steps, { action: 'requestExport', selector: '#export-email', directDownloadWaitMs: 1500 }], { windowFrom: '2026-07-27' });
    assert.equal(emailed.download, null);
    await assert.rejects(b.runSteps([{ action: 'goto', url: 'https://evil.example/' }, { action: 'requestExport', selector: '#x' }], {}), /inside Shopify Admin/);
    await assert.rejects(b.runSteps([{ action: 'goto', url: '/store/synthetic/orders' }], {}), /requestExport/);
    const f = await b.fetchDownload(`http://127.0.0.1:${server.address().port}/export.csv`);
    assert.deepEqual([f.status, f.body.toString('utf8'), f.finalHost], [200, CSV, '127.0.0.1']);
  } finally { await b.close(); server.close(); }
});
