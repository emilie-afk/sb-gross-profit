/**
 * Auth-state detection against synthetic pages (no network, no ShipStation).
 * Skips when Playwright or a Chromium build is not installed. Set SB_TEST_CHROMIUM
 * to a Chromium executable to use one other than Playwright's own download.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { detectAuthState, NEEDS_HUMAN, EXIT } from '../src/authState.mjs';

async function loadChromium() {
  try { return (await import('playwright')).chromium; } catch { /* try global */ }
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return createRequire(path.join(root, 'noop.js'))('playwright').chromium;
  } catch { return null; }
}

const chromium = await loadChromium();
const PAGES = {
  authenticated: '<nav aria-label="Main"><a href="/shipments">Shipments</a></nav><main>Orders</main>',
  login: '<form action="/login"><input name="username"><input type="password"><button type="submit">Sign in</button></form>',
  twoFactorSelector: '<p>Sign in</p><input autocomplete="one-time-code">',
  twoFactorText: '<h1>Enter the code we sent to your phone</h1><input name="x">',
  captcha: '<form action="/login"><input type="password"></form><div data-sitekey="abc" style="width:300px;height:80px">challenge</div>',
  invisibleBadge: '<form action="/login"><input type="password"></form><div data-sitekey="abc"></div>',
  expired: '<p>Your session has expired. Please sign in again.</p><input type="password">',
  unknown: '<h1>Scheduled maintenance</h1><p>Sign in later.</p>',
  hiddenLogin: '<nav aria-label="Main"></nav><a href="/shipments">Shipments</a><input type="password" style="display:none">',
};

test('authState on synthetic pages', { skip: !chromium && 'playwright not installed' }, async t => {
  let browser;
  try { browser = await chromium.launch(process.env.SB_TEST_CHROMIUM ? { executablePath: process.env.SB_TEST_CHROMIUM } : {}); }
  catch (e) { t.skip(`chromium unavailable: ${e.message.split('\n')[0]}`); return; }
  const page = await browser.newPage();
  const at = async html => { await page.setContent(html); return (await detectAuthState(page)).state; };
  try {
    assert.equal(await at(PAGES.authenticated), 'authenticated');
    assert.equal(await at(PAGES.login), 'login_required');
    assert.equal(await at(PAGES.twoFactorSelector), 'two_factor_required');
    assert.equal(await at(PAGES.twoFactorText), 'two_factor_required');
    assert.equal(await at(PAGES.captcha), 'captcha', 'a challenge wins over the login form under it');
    assert.equal(await at(PAGES.invisibleBadge), 'login_required', 'an invisible score badge is not a challenge');
    assert.equal(await at(PAGES.expired), 'session_expired', 'the notice wins over the password field');
    assert.equal(await at(PAGES.unknown), 'unknown', '"sign in" text alone is not evidence of a login page');
    assert.equal(await at(PAGES.hiddenLogin), 'authenticated', 'hidden fields are ignored');
    // Config selectors override the defaults
    await page.setContent('<div id="shell-x">ok</div>');
    assert.equal((await detectAuthState(page, { selectors: { authenticated: ['#shell-x'] } })).state, 'authenticated');
  } finally { await browser.close(); }
});

test('states that need a person and exit codes are distinct', () => {
  assert.ok(NEEDS_HUMAN.has('two_factor_required') && NEEDS_HUMAN.has('captcha') && NEEDS_HUMAN.has('unknown'));
  assert.ok(!NEEDS_HUMAN.has('authenticated') && !NEEDS_HUMAN.has('login_required'));
  assert.equal(new Set(Object.values(EXIT)).size, Object.keys(EXIT).length);
});
