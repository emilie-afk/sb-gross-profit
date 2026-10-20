/**
 * signinBlock.mjs - "the automated ShipStation window could not sign in"
 * =====================================================================
 * When the automated window cannot complete ShipStation's sign-in (a changed
 * sign-in page, a Cloudflare check that refuses automated browsers, 2FA, an
 * unexpected page), export.mjs records it here and later runs do NOT open the
 * automated window again: reopening it only puts an unusable window in front
 * of a person every retry. The block is lifted when a person signs in through
 * a normal window (npm run login), or for one retry with --retry-shipstation.
 * Codes and dates only; no credentials.
 */
import fs from 'node:fs';
import path from 'node:path';

export const SIGNIN_BLOCK_FILE = 'signin-block.json';

export function readSignInBlock(baseDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(baseDir, SIGNIN_BLOCK_FILE), 'utf8').replace(/^\uFEFF/, ''));
    return j && j.blocked ? j : null;
  } catch { return null; }
}

export function writeSignInBlock(baseDir, reason, now = new Date()) {
  const prev = readSignInBlock(baseDir);
  const rec = { blocked: true, since: prev ? prev.since : now.toISOString(), lastSeen: now.toISOString(), reason: String(reason || '').slice(0, 60) };
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(path.join(baseDir, SIGNIN_BLOCK_FILE), JSON.stringify(rec, null, 2));
  return rec;
}

export function clearSignInBlock(baseDir) {
  try { fs.rmSync(path.join(baseDir, SIGNIN_BLOCK_FILE), { force: true }); } catch { /* nothing to clear */ }
}
