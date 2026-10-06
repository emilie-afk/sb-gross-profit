/**
 * Run records and console output never keep a typed credential (2026-10-05: Playwright's call log
 * repeated the argument of fill(), the ShipStation password, into a local run record).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeError as shipstationSafe } from '../automation/shipstation-export/src/redact.mjs';
import { safeError as shopifySafe, localPaths, EXIT } from '../automation/shopify-export/src/lib.mjs';
import { registerSecret, scrub, serializeRecord, writeRunRecord, holdsSecret, _clearSecrets } from '../automation/shipstation-export/src/redact.mjs';
import { runCollector } from '../automation/shopify-export/src/collect.mjs';

const SECRET = 'Synthetic-Pass-123!';
const ODD = 'Syn"thetic\\Pass/é 42';                       // characters JSON and URL encoding change
const playwrightError = v => new Error(`locator.fill: Timeout 30000ms exceeded.\nCall log:\n  - waiting for locator('input[type="password"]').first()\n  - fill(${JSON.stringify(v)})\n`);

test('error text drops the call log and any typed value, registered or not', () => {
  _clearSecrets();
  for (const f of [shipstationSafe, shopifySafe]) {
    for (const e of [playwrightError(SECRET), new Error(`page.fill("${SECRET}") failed at https://example.invalid/login`)]) {
      const t = f(e);
      assert.ok(!t.includes(SECRET) && !t.includes('\n') && !t.includes('example.invalid'), t);
    }
    assert.equal(f(playwrightError(SECRET)), 'locator.fill: Timeout 30000ms exceeded.');
  }
});

test('a registered credential never reaches a run record, in any field or encoding', () => {
  _clearSecrets();
  registerSecret(SECRET); registerSecret(ODD);
  const record = { runId: 'ssx_test', status: 'export_failed', exitCode: 30,
    error: playwrightError(SECRET).message, nested: { detail: [`typed ${ODD}`, encodeURIComponent(ODD)] }, note: `${SECRET}${SECRET}` };
  const text = serializeRecord(record);
  for (const v of [SECRET, ODD, JSON.stringify(ODD).slice(1, -1), encodeURIComponent(ODD)]) assert.ok(!text.includes(v), `left ${v.length}-char form`);
  assert.ok(!holdsSecret(text));
  assert.equal(JSON.parse(text).status, 'export_failed', 'the record stays valid JSON');
  assert.equal(scrub(`a ${SECRET} b`), 'a <redacted> b');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-redact-'));
  writeRunRecord(path.join(dir, 'r.json'), record);
  assert.ok(!holdsSecret(fs.readFileSync(path.join(dir, 'r.json'), 'utf8')));
});

test('Shopify collector: a sign-in that fails with the password in the error leaves no trace in the run record', async () => {
  _clearSecrets();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-redact-'));
  const config = { localDir: dir, adminUrl: 'https://admin.shopify.com/store/synthetic', gmail: { mailbox: 'exports@example.invalid', pollSeconds: 60, timeoutMinutes: 45 } };
  const paths = { ...localPaths(config), runs: path.join(dir, 'runs') };
  const m = await runCollector({ config, paths, runId: 'shx_redact', week: { weekStart: '2026-09-28', weekEnd: '2026-10-04' },
    now: () => new Date('2026-10-05T08:05:00Z'), sleep: async () => {},
    gmailClient: async () => ({ mailbox: async () => 'exports@example.invalid', searchExportMessages: async () => [], readExportMessage: async () => ({}) }),
    browser: { open: async () => {}, authState: async () => ({ state: 'login_required', evidence: null }), close: async () => {},
               login: async c => { throw playwrightError(c.password); } },
    credential: () => ({ username: 'staff@example.invalid', password: SECRET }),
    upload: async () => ({ ok: true }) });
  assert.equal(m.authStateAtStart, 'login_required', 'the run reached the sign-in step');
  assert.equal(m.status, 'export_failed');
  assert.match(m.error, /^locator.fill: Timeout/, 'the error is kept, without its call log');
  const text = fs.readFileSync(path.join(dir, 'runs', 'shx_redact.json'), 'utf8');
  assert.ok(!text.includes(SECRET) && !holdsSecret(text), 'no form of the password in the run record');
});
