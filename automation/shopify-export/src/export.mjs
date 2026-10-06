#!/usr/bin/env node
/**
 * export.mjs — weekly rolling Shopify orders export (Windows host)
 * ================================================================
 *   node src/export.mjs --config config.local.json [--week 2026-09-14] [--headed]
 *
 * Wires Playwright (persistent profile outside the repository), Windows
 * Credential Manager, read-only Gmail and the Worker upload into
 * collect.mjs. See collect.mjs for the order of operations and README.md for
 * setup. No Shopify API is used; no password, 2FA code, cookie, token, email
 * body, download link or raw export is ever written to disk or a log.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { lastCompletedWeek, weekFromStart, render, purgeOlderThan } from '../../shipstation-export/src/lib.mjs';
import { uploadToWorker, workerEndpoint } from '../../shipstation-export/src/upload.mjs';
import { readWindowsCredential } from './credentials.mjs';
import { settleShopifyAuthState } from './authState.mjs';
import { gmailAccessToken, gmailClient } from './gmail.mjs';
import { assertCollectorConfig, adminOrigin, localPaths, EXIT, RETENTION_MS, INGEST_PATH, safeError, browserLaunchOptions, calendarDayPattern } from './lib.mjs';
import { runCollector } from './collect.mjs';

function argv() {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) o[a[i].slice(2)] = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true;
  return o;
}

/** Playwright adapter: every navigation stays inside the Shopify Admin origin. */
export function playwrightBrowser({ config, paths, headed, launchOptions = {}, beforeOpen = null }) {
  const origin = adminOrigin(config.adminUrl);
  let context, page;
  const inAdmin = url => { const u = new URL(url, origin); if (u.origin !== origin) throw new Error('Export steps may only navigate inside Shopify Admin'); return u.toString(); };
  return {
    async open() {
      context = await chromium.launchPersistentContext(paths.profile, { headless: !headed, acceptDownloads: true, ...launchOptions });
      if (beforeOpen) await beforeOpen(context);                            // tests only: offline routes
      page = context.pages()[0] || await context.newPage();
      await page.goto(config.adminUrl, { waitUntil: 'domcontentloaded' });
    },
    authState: () => settleShopifyAuthState(page, { adminOrigin: origin, selectors: config.auth?.selectors, text: config.auth?.text, settleMs: config.auth?.settleMs }),
    async login({ username, password }) {
      const f = config.loginForm || {};
      await page.locator(f.emailField || 'input#account_email').first().fill(username);
      if (f.emailSubmit !== null) await page.locator(f.emailSubmit || 'button[type="submit"]').first().click();
      await page.locator(f.passwordField || 'input#account_password').first().waitFor({ timeout: 15000 });
      await page.locator(f.passwordField || 'input#account_password').first().fill(password);
      await page.locator(f.submit || 'button[type="submit"]').first().click();
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(3000);
    },
    async runSteps(steps, vars) {
      let download = null;
      for (const [i, s] of steps.entries()) {
        if (!s.action && s._comment) continue;                               // documentation-only step
        const at = `step ${i + 1} (${s.action})`;
        const t = s.timeout || 15000;
        if (s.action === 'goto') await page.goto(inAdmin(render(s.url, vars)), { waitUntil: 'domcontentloaded' });
        else if (s.action === 'click') await page.locator(s.selector).first().click({ timeout: t });
        else if (s.action === 'fill') await page.locator(s.selector).first().fill(render(s.value, vars), { timeout: t });
        else if (s.action === 'select') await page.locator(s.selector).first().selectOption(render(s.value, vars));
        else if (s.action === 'check') await page.locator(s.selector).first().check({ timeout: t });
        else if (s.action === 'waitFor') await page.locator(s.selector).first().waitFor({ timeout: s.timeout || 30000 });
        else if (s.action === 'pickDateRange') {
          // Shopify's export calendar has no date fields: page back (or forward) to each month and click the day.
          // The calendar opens on the current month: page back to the start date, then forward to the end date.
          for (const [ymd, step] of [[render(s.from, vars), /^Show previous month/], [render(s.to, vars), /^Show next month/]]) {
            const day = page.getByRole('button', { name: calendarDayPattern(ymd) });
            for (let n = 0; n < 24 && !(await day.count()); n++) await page.getByRole('button', { name: step }).first().click({ timeout: t });
            await day.first().click({ timeout: t });
          }
        }
        else if (s.action === 'requestExport') {
          // Click "Export orders". Small exports download at once; large ones are emailed.
          const dl = page.waitForEvent('download', { timeout: s.directDownloadWaitMs || 20000 }).catch(() => null);
          await page.locator(s.selector).first().click({ timeout: t });
          const d = await dl;
          if (d) {
            const tmp = path.join(paths.downloads, `direct_${Date.now()}.csv`);
            await d.saveAs(tmp);
            try { download = fs.readFileSync(tmp); } finally { fs.rmSync(tmp, { force: true }); }   // raw file removed at once
          }
        } else throw new Error(`${at}: unknown action`);
      }
      if (!steps.some(s => s.action === 'requestExport')) throw new Error('Export steps need a requestExport step');
      return { download };
    },
    async fetchDownload(link) {
      const res = await context.request.get(link, { maxRedirects: 5, timeout: 120000 });
      let finalHost = null; try { finalHost = new URL(res.url()).hostname; } catch { /* keep null */ }
      if (res.status() === 200) return { status: 200, contentType: res.headers()['content-type'] || '', body: Buffer.from(await res.body()), finalHost };
      // Shopify answers the link's admin redirect with a "Verifying your connection" page (403) to a
      // non-browser request now and then (production, 2026-10-02 and -05). The browser's own navigation
      // passes it, so open the link in the page and take the file from the browser's response (CDP Fetch,
      // response stage), answering 204 so no browser-managed download starts (Edge closes on those).
      return browserFetchFile(context, page, link, { fallbackStatus: res.status(), fallbackHost: finalHost });
    },
    async close() { if (context) await context.close(); },
  };
}

/** The export file through the browser's own navigation (in memory; nothing written to disk). */
async function browserFetchFile(context, page, link, { fallbackStatus, fallbackHost, timeoutMs = 90000 }) {
  const cdp = await context.newCDPSession(page);
  let got = null;
  cdp.on('Fetch.requestPaused', async ev => {
    try {
      const h = Object.fromEntries((ev.responseHeaders || []).map(x => [x.name.toLowerCase(), x.value]));
      const isFile = ev.responseStatusCode === 200 && (/attachment/i.test(h['content-disposition'] || '') || /zip|csv|octet-stream/i.test(h['content-type'] || ''));
      if (!isFile) return await cdp.send('Fetch.continueRequest', { requestId: ev.requestId });
      const b = await cdp.send('Fetch.getResponseBody', { requestId: ev.requestId });
      got = { status: 200, contentType: h['content-type'] || '', body: Buffer.from(b.body, b.base64Encoded ? 'base64' : 'utf8'), finalHost: new URL(ev.request.url).hostname, via: 'browser' };
      await cdp.send('Fetch.fulfillRequest', { requestId: ev.requestId, responseCode: 204, responseHeaders: [], body: '' });
    } catch { /* the page moved on; the timeout below decides */ }
  });
  try {
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }] });
    await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});   // ends in ERR_ABORTED once the file is taken
    for (let waited = 0; !got && waited < timeoutMs; waited += 1000) await page.waitForTimeout(1000);
  } finally {
    await cdp.send('Fetch.disable').catch(() => {});
    await cdp.detach().catch(() => {});
  }
  return got || { status: fallbackStatus, contentType: '', body: Buffer.alloc(0), finalHost: fallbackHost };
}

/** One Shopify collection (used by the CLI and by the C7 collector orchestrator). */
export async function runShopifyJob({ config, week, headed = false, onWaiting = null, uploadImpl = uploadToWorker }) {
  assertCollectorConfig(config);
  const paths = localPaths(config);
  for (const d of Object.values(paths)) fs.mkdirSync(d, { recursive: true });
  workerEndpoint(config.workerUrl, INGEST_PATH);                               // fail fast on a bad URL
  purgeOlderThan(paths.quarantine, RETENTION_MS); purgeOlderThan(paths.downloads, RETENTION_MS);
  const runId = `shx_${new Date().toISOString().replace(/[:.]/g, '-')}`;
  return runCollector({
    config, week, paths, runId, onWaiting,
    browser: playwrightBrowser({ config, paths, headed, launchOptions: browserLaunchOptions(config) }),
    credential: target => readWindowsCredential(target),
    gmailClient: async () => {
      const client = readWindowsCredential(config.gmail.clientCredentialTarget || 'sb-gmail-oauth-client');
      const refresh = readWindowsCredential(config.gmail.credentialTarget || 'sb-gmail-readonly');
      const accessToken = await gmailAccessToken({ clientId: client.username, clientSecret: client.password, refreshToken: refresh.password });
      return gmailClient({ accessToken });
    },
    upload: async payload => {
      const { password: ingestSecret } = readWindowsCredential(config.ingestCredentialTarget || 'sb-gp-ingest');
      return uploadImpl({ workerUrl: config.workerUrl, ingestSecret, path: INGEST_PATH, payload });
    },
  });
}

async function main() {
  const args = argv();
  const config = JSON.parse(fs.readFileSync(args.config || 'config.local.json', 'utf8'));
  const week = args.week ? weekFromStart(args.week) : lastCompletedWeek(new Date(), config.timeZone || 'America/Los_Angeles');
  const m = await runShopifyJob({ config, week, headed: !!args.headed });
  console.log(`${m.status} (exit ${m.exitCode})`);
  process.exitCode = m.exitCode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(e => { console.error(safeError(e)); process.exitCode = EXIT.CONFIG; });
}
