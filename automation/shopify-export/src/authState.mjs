/**
 * authState.mjs — what the Shopify Admin page is asking for
 * ========================================================
 * Same contract as the ShipStation job (never guess; stop on 2FA, captcha or
 * an unknown page). The defaults below are Shopify's sign-in and Admin pages;
 * `auth.selectors` in config.local.json replaces any list after recording the
 * pages on the Windows host. Authenticated also requires the Admin origin.
 */
import { detectAuthState as detect } from '../../shipstation-export/src/authState.mjs';

export const SHOPIFY_AUTH_SELECTORS = Object.freeze({
  authenticated: ['nav[aria-label="Main"]', '#AppFrameNav', '[data-polaris-layer] nav', 'a[href*="/orders"]'],
  login: ['input#account_email', 'input[name="account[email]"]', 'input#account_password', 'input[type="password"]'],
  twoFactor: ['input#account_tfa_code', 'input[name="tfa_code"]', 'input[autocomplete="one-time-code"]'],
  captcha: ['iframe[src*="hcaptcha"]', 'iframe[src*="recaptcha"]', '[data-sitekey]', '#challenge-form'],
});
export const SHOPIFY_AUTH_TEXT = Object.freeze({
  twoFactor: /(two-step|2-step|verification code|authentication code|authenticator app|enter the code)/i,
  captcha: /(verify you are human|are you a robot|security check|confirm you('| a)re human)/i,
  sessionExpired: /(session (has )?expired|you('| ha)ve been logged out|log in again)/i,
});

export async function detectShopifyAuthState(page, { adminOrigin, selectors = {}, text = {} } = {}) {
  const r = await detect(page, { selectors: { ...SHOPIFY_AUTH_SELECTORS, ...selectors }, text: { ...SHOPIFY_AUTH_TEXT, ...text } });
  if (r.state === 'authenticated' && adminOrigin && !String(page.url()).startsWith(adminOrigin)) return { state: 'unknown', evidence: 'not_admin_origin' };
  return r;
}

export const NEEDS_HUMAN = new Set(['two_factor_required', 'captcha', 'unknown']);
