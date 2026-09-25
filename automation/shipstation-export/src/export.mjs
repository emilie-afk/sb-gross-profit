#!/usr/bin/env node
/**
 * export.mjs — weekly ShipStation custom shipment export (Windows host)
 * ====================================================================
 *   node src/export.mjs --config config.local.json [--week 2026-09-14] [--headed]
 *
 * 1. Opens a persistent browser profile kept OUTSIDE the repository
 *    (%LOCALAPPDATA%\sb-shipstation-export\profile).
 * 2. Classifies the page (authState.mjs). If a login form is shown, fills it
 *    from Windows Credential Manager. If 2FA or a captcha is shown, stops with
 *    a distinct exit code so a person can run login.mjs once.
 * 3. Only when authenticated, runs the export steps recorded in config.
 * 4. Refuses any file whose headers include customer columns, or that is not a
 *    valid export (no rows, no shipment/order/cost columns).
 * 5. Uploads the CSV straight to the Worker (/v1/ingest/shipstation) with the
 *    ingest secret from Windows Credential Manager (delivery "worker", the
 *    default). delivery "drive" keeps the old copy-to-folder behaviour for
 *    rollback only.
 * 6. Writes a run manifest (week, export time, source hash, ingest result; no
 *    secrets, no row data) and exits with EXIT codes.
 *
 * Nothing here stores a password, 2FA code, session cookie or browser token.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { detectAuthState, NEEDS_HUMAN, EXIT } from './authState.mjs';
import { readWindowsCredential } from './credentials.mjs';
import { lastCompletedWeek, weekFromStart, render, customerHeaders, csvHeaderNames, sha256, localPaths, assertNoSecretsInConfig, invalidExportReason, purgeOlderThan, resolveDelivery, MAPPING_EXPORT_COLUMNS, unexpectedColumns } from './lib.mjs';
import { uploadShipStationCsv, UPLOAD_EXIT, workerEndpoint } from './upload.mjs';

function argv() {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) o[a[i].slice(2)] = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true;
  return o;
}

async function runSteps(page, steps, vars, downloadsDir) {
  let file = null;
  for (const [i, s] of steps.entries()) {
    const at = `step ${i + 1} (${s.action})`;
    if (s.action === 'goto') await page.goto(render(s.url, vars), { waitUntil: 'domcontentloaded' });
    else if (s.action === 'click') await page.locator(s.selector).first().click({ timeout: s.timeout || 15000 });
    else if (s.action === 'fill') await page.locator(s.selector).first().fill(render(s.value, vars), { timeout: s.timeout || 15000 });
    else if (s.action === 'select') await page.locator(s.selector).first().selectOption(render(s.value, vars));
    else if (s.action === 'waitFor') await page.locator(s.selector).first().waitFor({ timeout: s.timeout || 30000 });
    else if (s.action === 'download') {
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: s.timeout || 120000 }), page.locator(s.selector).first().click()]);
      file = path.join(downloadsDir, `download_${Date.now()}.csv`);
      await dl.saveAs(file);
    } else throw new Error(`${at}: unknown action`);
  }
  if (!file) throw new Error('Export steps finished without a download step');
  return file;
}

async function main() {
  const args = argv();
  const configPath = args.config || 'config.local.json';
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assertNoSecretsInConfig(config);
  const paths = localPaths(config);
  for (const d of Object.values(paths)) fs.mkdirSync(d, { recursive: true });
  const { delivery } = resolveDelivery(config);                          // Worker by default; Drive only if explicit
  if (delivery === 'worker') workerEndpoint(config.workerUrl);            // fail fast on a bad URL
  purgeOlderThan(paths.quarantine, 72 * 3600_000);                        // also runs daily from purge.mjs
  const week = args.week ? weekFromStart(args.week) : lastCompletedWeek(new Date(), config.timeZone);
  const runId = `ssx_${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const manifest = { runId, weekStart: week.weekStart, weekEnd: week.weekEnd, startedAt: new Date().toISOString(), status: 'running' };
  const finish = (status, exitCode, extra = {}) => {
    Object.assign(manifest, { status, exitCode, finishedAt: new Date().toISOString(), ...extra });
    fs.writeFileSync(path.join(paths.runs, `${runId}.json`), JSON.stringify(manifest, null, 2));
    console.log(`${status} (exit ${exitCode})`);
    process.exitCode = exitCode;
  };

  const context = await chromium.launchPersistentContext(paths.profile, { headless: !args.headed, acceptDownloads: true });
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(config.appUrl, { waitUntil: 'domcontentloaded' });
    let { state, evidence } = await detectAuthState(page, config.auth);
    manifest.authStateAtStart = state;

    if (state === 'login_required' || state === 'session_expired') {
      if (state === 'session_expired' && config.loginUrl) await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded' });
      const { username, password } = readWindowsCredential(config.credentialTarget || 'sb-shipstation-export');
      await page.locator(config.loginForm.usernameField).first().fill(username);
      await page.locator(config.loginForm.passwordField).first().fill(password);
      await page.locator(config.loginForm.submit).first().click();
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(2000);
      ({ state, evidence } = await detectAuthState(page, config.auth));
      if (state === 'login_required') return finish('login_failed', EXIT.LOGIN_FAILED);
    }
    if (state === 'two_factor_required') return finish('needs_2fa', EXIT.NEEDS_2FA, { note: 'Run login.mjs in headed mode once to complete 2FA' });
    if (state === 'captcha') return finish('needs_human_captcha', EXIT.CAPTCHA);
    if (NEEDS_HUMAN.has(state) || state !== 'authenticated') return finish('unknown_page', EXIT.UNKNOWN_PAGE, { evidence });

    const file = await runSteps(page, config.exportSteps || [], week, paths.downloads);
    const buf = fs.readFileSync(file);
    const headers = csvHeaderNames(buf.toString('utf8'));
    const pii = [...new Set([...customerHeaders(headers), ...unexpectedColumns(headers, MAPPING_EXPORT_COLUMNS)])];
    if (pii.length) {
      fs.rmSync(file);                                        // never forward customer columns
      return finish('refused_customer_columns', EXIT.EXPORT_FAILED, { headers, customerHeaders: pii,
        note: 'The export must contain exactly the saved template columns; remove these columns from it' });
    }
    const text = buf.toString('utf8');
    const rows = text.split(/\r?\n/).filter(l => l.trim()).length - 1;
    const invalid = invalidExportReason(headers, rows);
    if (invalid) {
      fs.rmSync(file);
      return finish('invalid_export', EXIT.EXPORT_FAILED, { headers, rowCount: rows, reason: invalid });
    }
    const exportedAt = new Date().toISOString();
    const outName = `shipstation_${week.weekStart}_${runId}.csv`;
    const facts = { exportedAt, bytes: buf.length, sha256: sha256(buf), headers, rowCount: rows };
    if (delivery === 'drive') {                                            // rollback path only
      fs.mkdirSync(config.outputDir, { recursive: true });
      fs.copyFileSync(file, path.join(config.outputDir, outName));
      fs.rmSync(file);
      return finish('ok', EXIT.OK, { ...facts, delivery, file: outName });
    }
    const { password: ingestSecret } = readWindowsCredential(config.ingestCredentialTarget || 'sb-gp-ingest');
    const ingest = await uploadShipStationCsv({ workerUrl: config.workerUrl, ingestSecret, weekStart: week.weekStart, text, exportedAt });
    if (!ingest.ok) {
      fs.renameSync(file, path.join(paths.quarantine, outName));            // kept ≤72h for a manual retry, never synced
      return finish('upload_failed', UPLOAD_EXIT, { ...facts, delivery, ingest, quarantined: outName });
    }
    fs.rmSync(file);
    return finish('ok', EXIT.OK, { ...facts, delivery, ingest });
  } catch (e) {
    return finish('export_failed', EXIT.EXPORT_FAILED, { error: e.message.slice(0, 300) });
  } finally {
    await context.close();
  }
}

main().catch(e => { console.error(e.message); process.exitCode = EXIT.CONFIG; });
