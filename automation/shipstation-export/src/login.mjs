#!/usr/bin/env node
/**
 * login.mjs — one-time interactive sign-in (headed)
 * ================================================
 *   node src/login.mjs --config config.local.json
 *
 * Opens a visible browser on the persistent profile outside the repository.
 * A person signs in and completes 2FA themselves; nothing typed is read or
 * recorded by this script. It waits until the page is classified as
 * authenticated, then closes. The profile keeps the session for later
 * unattended runs until ShipStation expires it; export.mjs then exits with
 * NEEDS_2FA and this script is run again.
 */
import fs from 'node:fs';
import { chromium } from 'playwright';
import { detectAuthState } from './authState.mjs';
import { localPaths, assertNoSecretsInConfig } from './lib.mjs';

const i = process.argv.indexOf('--config');
const config = JSON.parse(fs.readFileSync(i > 0 ? process.argv[i + 1] : 'config.local.json', 'utf8'));
assertNoSecretsInConfig(config);
const { profile } = localPaths(config);
fs.mkdirSync(profile, { recursive: true });

const context = await chromium.launchPersistentContext(profile, { headless: false });
const page = context.pages()[0] || await context.newPage();
await page.goto(config.loginUrl || config.appUrl);
console.log('Sign in and complete any verification in the browser window. Waiting up to 10 minutes…');
const deadline = Date.now() + 10 * 60 * 1000;
let state = 'unknown';
while (Date.now() < deadline) {
  ({ state } = await detectAuthState(page, config.auth));
  if (state === 'authenticated') break;
  await page.waitForTimeout(3000);
}
await context.close();
console.log(state === 'authenticated' ? 'Signed in. The session is stored in the local profile only.' : `Stopped: page state is ${state}.`);
process.exitCode = state === 'authenticated' ? 0 : 20;
