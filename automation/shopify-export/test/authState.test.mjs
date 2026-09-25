/**
 * Shopify sign-in state detection against synthetic pages (no network, no
 * Shopify). Skips when Playwright or a Chromium build is not installed. Set
 * SB_TEST_CHROMIUM to use a Chromium other than Playwright's own download.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { detectShopifyAuthState, NEEDS_HUMAN } from '../src/authState.mjs';
import { EXIT } from '../src/lib.mjs';

async function loadChromium() {
  try { return (await import('playwright')).chromium; } catch { /* try global */ }
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return createRequire(path.join(root, 'noop.js'))('playwright').chromium;
  } catch { return null; }
}

const chromium = await loadChromium();
const ORIGIN = 'https://admin.shopify.com';
const PAGES = {
  admin: '<nav aria-label="Main"><a href="/store/synthetic/orders">Orders</a></nav><main>Orders</main>',
  email: '<form><input id="account_email" name="account[email]"><button type="submit">Continue with email</button></form>',
  password: '<form><input id="account_password" type="password"><button type="submit">Log in</button></form>',
  tfa: '<h1>Two-step authentication</h1><input id="account_tfa_code">',
  tfaText: '<h1>Enter the code from your authenticator app</h1><input name="x">',
  captcha: '<form><input id="account_email"></form><iframe src="https://newassets.hcaptcha.com/x" style="width:300px;height:80px"></iframe>',
  expired: '<p>Your session has expired. Log in again.</p><input id="account_email">',
  unknown: '<h1>Shopify is down for maintenance</h1>',
  discount: '<nav aria-label="Main"><a href="/store/synthetic/orders">Orders</a></nav><label>Discount code</label><input name="discount_code">',
};

test('Shopify authState on synthetic pages', { skip: !chromium && 'playwright not installed' }, async t => {
  let browser;
  try { browser = await chromium.launch(process.env.SB_TEST_CHROMIUM ? { executablePath: process.env.SB_TEST_CHROMIUM } : {}); }
  catch (e) { t.skip(`chromium unavailable: ${e.message.split('\n')[0]}`); return; }
  const page = await browser.newPage();
  let html = '';
  await page.route('https://**/*', r => r.fulfill({ status: 200, contentType: 'text/html', body: html }));
  const at = async (h, url = `${ORIGIN}/store/synthetic/orders`) => { html = h; await page.goto(url); return (await detectShopifyAuthState(page, { adminOrigin: ORIGIN })).state; };
  try {
    assert.equal(await at(PAGES.admin), 'authenticated');
    assert.equal(await at(PAGES.admin, 'https://evil.example/store/synthetic/orders'), 'unknown', 'Admin shell outside the Admin origin');
    assert.equal(await at(PAGES.email, 'https://accounts.shopify.com/lookup'), 'login_required');
    assert.equal(await at(PAGES.password, 'https://accounts.shopify.com/login'), 'login_required');
    assert.equal(await at(PAGES.tfa, 'https://accounts.shopify.com/tfa'), 'two_factor_required');
    assert.equal(await at(PAGES.tfaText, 'https://accounts.shopify.com/tfa'), 'two_factor_required');
    assert.equal(await at(PAGES.captcha, 'https://accounts.shopify.com/lookup'), 'captcha');
    assert.equal(await at(PAGES.expired, 'https://accounts.shopify.com/lookup'), 'session_expired');
    assert.equal(await at(PAGES.unknown), 'unknown');
    assert.equal(await at(PAGES.discount), 'authenticated', 'a discount-code field on an Admin page is not 2FA');
  } finally { await browser.close(); }
});

test('states that need a person and exit codes are distinct', () => {
  assert.ok(NEEDS_HUMAN.has('two_factor_required') && NEEDS_HUMAN.has('captcha') && NEEDS_HUMAN.has('unknown'));
  assert.equal(new Set(Object.values(EXIT)).size, Object.keys(EXIT).length);
});
