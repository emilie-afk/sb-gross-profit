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
  for (const s of ["blocked('login_failed'", "blocked('needs_2fa'", "blocked('needs_human_captcha'", "blocked('unknown_page'"]) assert.ok(src.includes(s), s);
  const login = fs.readFileSync(path.join(HERE, '..', 'src', 'login.mjs'), 'utf8');
  assert.match(login, /clearSignInBlock\(paths\.base\)/);
  assert.match(login, /spawn\(exe, \[`--user-data-dir=/, 'the default sign-in is a normal (non-automated) window');
});
