/**
 * Synthetic site-password gate configuration for tests: random password and keys, never real values.
 * gateCookieHeader(cfg) → a `cookie` header value carrying a freshly signed gate session.
 */
import crypto from 'node:crypto';
import { signGateToken, GATE_COOKIE } from '../shared/gateSession.js';

export function gateConfig(extra = {}) {
  return { sitePassword: `site-${crypto.randomBytes(9).toString('hex')}`, signingKey: crypto.randomBytes(32).toString('base64url'),
           epoch: '1', gateSecret: crypto.randomBytes(32).toString('base64url'), ...extra };
}
export async function gateToken(cfg, opts = {}) { return signGateToken({ signingKey: cfg.signingKey, epoch: cfg.epoch, ...opts }); }
export async function gateCookieHeader(cfg, opts = {}) { return `${GATE_COOKIE}=${(await gateToken(cfg, opts)).token}`; }
