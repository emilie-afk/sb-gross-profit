/**
 * authState.mjs — decide what the ShipStation page is asking for
 * ==============================================================
 * The export job must never guess. Before any action it classifies the page:
 *
 *   authenticated          the app shell is present; safe to export
 *   login_required         a username/password form is shown
 *   two_factor_required    a verification-code prompt is shown — a human must complete it
 *   captcha                a bot challenge is shown — a human must complete it
 *   session_expired        an explicit "session expired / signed out" notice
 *   unknown                none of the above; stop rather than click blindly
 *
 * Selectors come from config (ShipStation's DOM changes). Text patterns are the
 * fallback, so a renamed CSS class degrades to "unknown", not to a wrong action.
 */

export const DEFAULT_AUTH_SELECTORS = Object.freeze({
  authenticated: ['[data-testid="app-shell"]', 'nav[aria-label="Main"]', '#app-header', 'a[href*="/shipments"]'],
  login: ['input[type="password"]', 'form[action*="login"]', 'input[name="username"]'],
  twoFactor: ['input[autocomplete="one-time-code"]', 'input[name*="code" i]', '[data-testid*="two-factor" i]'],
  captcha: ['iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', '[data-sitekey]', '#challenge-form'],
});

export const DEFAULT_AUTH_TEXT = Object.freeze({
  twoFactor: /(verification code|two[- ]factor|2-step|authenticator|enter the code)/i,
  captcha: /(verify you are human|are you a robot|security check)/i,
  sessionExpired: /(session (has )?expired|you have been signed out|please sign in again)/i,
});

async function anyVisible(page, selectors) {
  for (const s of selectors || []) {
    try { if (await page.locator(s).first().isVisible({ timeout: 250 })) return s; } catch { /* not present */ }
  }
  return null;
}

/**
 * @param {import('playwright').Page} page
 * @param {{ selectors?: object, text?: object }} [opts]
 * @returns {Promise<{ state: string, evidence: string|null }>}
 */
export async function detectAuthState(page, opts = {}) {
  const sel = { ...DEFAULT_AUTH_SELECTORS, ...(opts.selectors || {}) };
  const txt = { ...DEFAULT_AUTH_TEXT, ...(opts.text || {}) };
  const body = (await page.locator('body').innerText({ timeout: 2000 }).catch(() => '')) || '';

  // Order matters: a challenge can sit on top of a login form, and a 2FA page
  // often still contains the words "sign in".
  let hit;
  if ((hit = await anyVisible(page, sel.captcha)) || txt.captcha.test(body)) return { state: 'captcha', evidence: hit || 'text' };
  if ((hit = await anyVisible(page, sel.twoFactor)) || txt.twoFactor.test(body)) return { state: 'two_factor_required', evidence: hit || 'text' };
  if (txt.sessionExpired.test(body)) return { state: 'session_expired', evidence: 'text' };
  if ((hit = await anyVisible(page, sel.login))) return { state: 'login_required', evidence: hit };
  if ((hit = await anyVisible(page, sel.authenticated))) return { state: 'authenticated', evidence: hit };
  // No text fallback for login: "sign in" appears on too many pages to be evidence.
  return { state: 'unknown', evidence: null };
}

/** States that need a person. The job exits and notifies rather than proceeding. */
export const NEEDS_HUMAN = new Set(['two_factor_required', 'captcha', 'unknown']);

/** Process exit codes, so Task Scheduler and the run manifest agree. */
export const EXIT = Object.freeze({ OK: 0, CONFIG: 10, NEEDS_2FA: 20, CAPTCHA: 21, UNKNOWN_PAGE: 22, LOGIN_FAILED: 23, EXPORT_FAILED: 30 });
