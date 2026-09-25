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
import { detectShopifyAuthState } from './authState.mjs';
import { gmailAccessToken, gmailClient } from './gmail.mjs';
import { assertCollectorConfig, adminOrigin, localPaths, EXIT, RETENTION_MS, INGEST_PATH, safeError } from './lib.mjs';
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
    authState: () => detectShopifyAuthState(page, { adminOrigin: origin, selectors: config.auth?.selectors, text: config.auth?.text }),
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
      return { status: res.status(), contentType: res.headers()['content-type'] || '', body: Buffer.from(await res.body()), finalHost };
    },
    async close() { if (context) await context.close(); },
  };
}

async function main() {
  const args = argv();
  const config = JSON.parse(fs.readFileSync(args.config || 'config.local.json', 'utf8'));
  assertCollectorConfig(config);
  const paths = localPaths(config);
  for (const d of Object.values(paths)) fs.mkdirSync(d, { recursive: true });
  workerEndpoint(config.workerUrl, INGEST_PATH);                               // fail fast on a bad URL
  purgeOlderThan(paths.quarantine, RETENTION_MS); purgeOlderThan(paths.downloads, RETENTION_MS);
  const week = args.week ? weekFromStart(args.week) : lastCompletedWeek(new Date(), config.timeZone || 'America/Los_Angeles');
  const runId = `shx_${new Date().toISOString().replace(/[:.]/g, '-')}`;

  const m = await runCollector({
    config, week, paths, runId,
    browser: playwrightBrowser({ config, paths, headed: !!args.headed }),
    credential: target => readWindowsCredential(target),
    gmailClient: async () => {
      const client = readWindowsCredential(config.gmail.clientCredentialTarget || 'sb-gmail-oauth-client');
      const refresh = readWindowsCredential(config.gmail.credentialTarget || 'sb-gmail-readonly');
      const accessToken = await gmailAccessToken({ clientId: client.username, clientSecret: client.password, refreshToken: refresh.password });
      return gmailClient({ accessToken });
    },
    upload: async payload => {
      const { password: ingestSecret } = readWindowsCredential(config.ingestCredentialTarget || 'sb-gp-ingest');
      return uploadToWorker({ workerUrl: config.workerUrl, ingestSecret, path: INGEST_PATH, payload });
    },
  });
  console.log(`${m.status} (exit ${m.exitCode})`);
  process.exitCode = m.exitCode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(e => { console.error(safeError(e)); process.exitCode = EXIT.CONFIG; });
}
