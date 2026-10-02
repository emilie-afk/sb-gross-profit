/**
 * Export steps against a synthetic page (no network, no ShipStation): the network-capture download
 * (the report request is answered from the network, the page gets an empty 204, the browser never
 * downloads), settle waits, and the late-rendering sign-in check. Skips without Chromium.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { settleAuthState } from '../src/authState.mjs';

let chromium = null, runSteps = null;
try { chromium = (await import('playwright')).chromium; ({ runSteps } = await import('../src/export.mjs')); } catch { chromium = null; }
const CSV = 'Ship Date,Order #,Shipping Cost\n9/1/2026,1001,5.10\n';

test('steps: capture download, waits and late sign-in detection on a synthetic page', { skip: !chromium && 'playwright not installed' }, async t => {
  let browser;
  try { browser = await chromium.launch(process.env.SB_TEST_CHROMIUM ? { executablePath: process.env.SB_TEST_CHROMIUM } : {}); }
  catch (e) { t.skip(`chromium unavailable: ${e.message.split('\n')[0]}`); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-steps-'));
  try {
    const ctx = await browser.newContext({ acceptDownloads: true });
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/api/download/report/')) { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="r.csv"' }); res.end(CSV); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<script>setTimeout(() => document.body.innerHTML = '<a href="/dashboard">Insights</a><button id="csv" onclick="location.href=\\'/api/download/report/1/2.csv\\'">CSV</button>', 600)</script>`);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    const origin = `http://127.0.0.1:${server.address().port}`;
    let pageDownloads = 0;
    const page = await ctx.newPage();
    page.on('download', () => pageDownloads++);
    await page.goto(`${origin}/dashboard/reports/ShippingCosts`);
    const auth = await settleAuthState(page, { selectors: { authenticated: ['a[href="/dashboard"]'] } }, { settleMs: 5000 });
    assert.equal(auth.state, 'authenticated', 'found once the app rendered');
    const file = await runSteps(page, [{ action: 'waitForLoad' }, { action: 'wait', ms: 100 },
      { action: 'download', selector: 'role=button[name="CSV"]', capture: '**/api/download/report/**', timeout: 15000 }], {}, dir);
    assert.equal(fs.readFileSync(file, 'utf8'), CSV, 'the report bytes, taken from the network');
    assert.equal(pageDownloads, 0, 'the browser never started a download');
    await assert.rejects(runSteps(page, [{ action: 'download', selector: 'role=button[name="CSV"]', capture: '**/never/**', timeout: 1500 }], {}, dir), /report download failed/);
  } finally { await browser.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
