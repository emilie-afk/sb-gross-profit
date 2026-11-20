/**
 * The automated ShipStation window is not reopened after it failed to sign in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSignInBlock, writeSignInBlock, clearSignInBlock } from '../src/signinBlock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('sign-in block: written on failure, first date kept, cleared after a person signs in', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-block-'));
  try {
    assert.equal(readSignInBlock(dir), null);
    const a = writeSignInBlock(dir, 'login_failed', new Date('2026-10-19T08:00:00Z'));
    const b = writeSignInBlock(dir, 'login_failed', new Date('2026-10-19T09:00:00Z'));
    assert.equal(b.since, a.since);
    assert.equal(readSignInBlock(dir).reason, 'login_failed');
    assert.ok(!JSON.stringify(readSignInBlock(dir)).match(/password|secret|token/i));
    clearSignInBlock(dir);
    assert.equal(readSignInBlock(dir), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('export: the block is checked before any browser opens; failed sign-ins set it; login clears it', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'src', 'export.mjs'), 'utf8');
  const check = src.indexOf('readSignInBlock(paths.base)'), launch = src.indexOf('chromium.launchPersistentContext');
  assert.ok(check > 0 && launch > check);
  for (const s of ["blocked('login_failed'", "blocked('needs_2fa'", "blocked('needs_human_captcha'"]) assert.ok(src.includes(s), s);
  // An unrecognised page is not a sign-out: it never sets the block, and an old unknown_page block is dropped.
  assert.ok(!src.includes("blocked('unknown_page'"), 'unknown_page must not set the sign-in block');
  assert.match(src, /block\.reason === 'unknown_page'\) \{ clearSignInBlock\(paths\.base\); block = null; \}/);
  const login = fs.readFileSync(path.join(HERE, '..', 'src', 'login.mjs'), 'utf8');
  assert.match(login, /clearSignInBlock\(paths\.base\)/);
  assert.match(login, /spawn\(exe, \[`--user-data-dir=/, 'the default sign-in is a normal (non-automated) window');
});

test('export: only the Shipping Cost Report job sets the block; an unknown page records where it was', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'src', 'export.mjs'), 'utf8');
  assert.match(src, /const blocked = \(status, code, extra = \{\}\) => \{ if \(!aps\) writeSignInBlock\(paths\.base, status\)/);
  assert.match(src, /finish\('unknown_page', EXIT\.UNKNOWN_PAGE, \{ evidence, page: where \}\)/);
  assert.match(src, /if \(state === 'unknown'\) \{[\s\S]{0,300}settleAuthState/, 'an unknown page is loaded once more before giving up');
  assert.ok(!/page\.url\(\)[^;]*search/.test(src), 'no query string recorded');
});
