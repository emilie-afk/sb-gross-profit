#!/usr/bin/env node
/**
 * login.mjs — interactive sign-in in a NORMAL browser window
 * =========================================================
 *   node src/login.mjs --config config.local.json              (normal window, default)
 *   node src/login.mjs --config config.local.json --automated  (the old Playwright window)
 *
 * ShipStation's sign-in page (Cloudflare) refuses browsers controlled by
 * automation, so by default this opens an ordinary Chrome/Edge window on the
 * same persistent profile the export uses (outside the repository). A person
 * signs in and completes any verification, waits for the ShipStation home page,
 * then CLOSES the window. Nothing typed is read or recorded by this script.
 * Closing the window lifts the sign-in block (signinBlock.mjs), so the next
 * export run tries the automated window once more.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { detectAuthState } from './authState.mjs';
import { localPaths, assertNoSecretsInConfig, browserLaunchOptions } from './lib.mjs';
import { clearSignInBlock } from './signinBlock.mjs';

const i = process.argv.indexOf('--config');
const config = JSON.parse(fs.readFileSync(i > 0 ? process.argv[i + 1] : 'config.local.json', 'utf8'));
assertNoSecretsInConfig(config);
const paths = localPaths(config);
fs.mkdirSync(paths.profile, { recursive: true });
const url = config.loginUrl || config.appUrl;

function browserExe() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const la = process.env.LOCALAPPDATA || '';
  const list = config.browserChannel === 'msedge'
    ? [path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')]
    : [path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
       path.join(la, 'Google', 'Chrome', 'Application', 'chrome.exe')];
  return list.find(p => fs.existsSync(p)) || null;
}

if (!process.argv.includes('--automated')) {
  const exe = browserExe();
  if (!exe) { console.error('Chrome/Edge not found; run with --automated instead.'); process.exit(10); }
  console.log('A normal browser window is opening on the export profile. Sign in to ShipStation (and any verification),');
  console.log('wait for the ShipStation home page, then CLOSE that window. Make sure no other window uses this profile.');
  const child = spawn(exe, [`--user-data-dir=${paths.profile}`, '--no-first-run', '--no-default-browser-check', '--new-window', url], { stdio: 'ignore' });
  await new Promise(res => child.on('exit', res));
  clearSignInBlock(paths.base);
  console.log('Window closed. The next export run will use this sign-in (it tries the automated window once).');
  process.exitCode = 0;
} else {
  const { chromium } = await import('playwright');
  const context = await chromium.launchPersistentContext(paths.profile, { headless: false, ...browserLaunchOptions(config) });
  const page = context.pages()[0] || await context.newPage();
  await page.goto(url);
  console.log('Sign in and complete any verification in the browser window. Waiting up to 10 minutes…');
  const deadline = Date.now() + 10 * 60 * 1000;
  let state = 'unknown';
  while (Date.now() < deadline) {
    ({ state } = await detectAuthState(page, config.auth));
    if (state === 'authenticated') break;
    await page.waitForTimeout(3000);
  }
  await context.close();
  if (state === 'authenticated') clearSignInBlock(paths.base);
  console.log(state === 'authenticated' ? 'Signed in. The session is stored in the local profile only.' : `Stopped: page state is ${state}.`);
  process.exitCode = state === 'authenticated' ? 0 : 20;
}
