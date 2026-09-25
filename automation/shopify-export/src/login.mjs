#!/usr/bin/env node
/**
 * login.mjs — one-time interactive Shopify sign-in (visible browser)
 *   node src/login.mjs --config config.local.json
 * A person signs in with the dedicated staff account and completes 2FA; nothing
 * typed is read or recorded. The session stays in the local profile (outside
 * the repository) until Shopify expires it; export.mjs then exits 20 and this
 * is run again.
 */
import fs from 'node:fs';
import { chromium } from 'playwright';
import { detectShopifyAuthState } from './authState.mjs';
import { assertCollectorConfig, adminOrigin, localPaths } from './lib.mjs';

const i = process.argv.indexOf('--config');
const config = JSON.parse(fs.readFileSync(i > 0 ? process.argv[i + 1] : 'config.local.json', 'utf8'));
assertCollectorConfig(config);
const { profile } = localPaths(config);
fs.mkdirSync(profile, { recursive: true });
const origin = adminOrigin(config.adminUrl);

const context = await chromium.launchPersistentContext(profile, { headless: false });
const page = context.pages()[0] || await context.newPage();
await page.goto(config.adminUrl);
console.log('Sign in with the dedicated Shopify staff account and complete any verification. Waiting up to 10 minutes…');
const deadline = Date.now() + 10 * 60 * 1000;
let state = 'unknown';
while (Date.now() < deadline) {
  ({ state } = await detectShopifyAuthState(page, { adminOrigin: origin, selectors: config.auth?.selectors, text: config.auth?.text }));
  if (state === 'authenticated') break;
  await page.waitForTimeout(3000);
}
await context.close();
console.log(state === 'authenticated' ? 'Signed in. The session is stored in the local profile only.' : `Stopped: page state is ${state}.`);
process.exitCode = state === 'authenticated' ? 0 : 20;
