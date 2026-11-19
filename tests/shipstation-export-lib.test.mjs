/** Pure helpers of the ShipStation export job (automation/shipstation-export/src/lib.mjs). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { lastCompletedWeek, weekFromStart, render, customerHeaders, csvHeaderNames, localPaths, assertNoSecretsInConfig }
  from '../automation/shipstation-export/src/lib.mjs';
import fs from 'node:fs';

test('lastCompletedWeek uses the store time zone and Monday–Sunday weeks', () => {
  // Monday 2026-09-21 06:30 UTC is still Sunday 23:30 in Los Angeles (PDT).
  assert.deepEqual(lastCompletedWeek(new Date('2026-09-21T06:30:00Z')),
    { weekStart: '2026-09-07', weekEnd: '2026-09-13', weekStartUS: '09/07/2026', weekEndUS: '09/13/2026' });
  assert.equal(lastCompletedWeek(new Date('2026-09-21T07:30:00Z')).weekStart, '2026-09-14');
  assert.equal(lastCompletedWeek(new Date('2026-09-27T20:00:00Z')).weekStart, '2026-09-14');
});

test('weekFromStart requires a Monday', () => {
  assert.equal(weekFromStart('2026-09-14').weekEnd, '2026-09-20');
  assert.throws(() => weekFromStart('2026-09-15'), /Monday/);
  assert.throws(() => weekFromStart('09/14/2026'), /YYYY-MM-DD/);
});

test('render refuses unknown placeholders', () => {
  assert.equal(render('{{weekStartUS}}-{{weekEndUS}}', { weekStartUS: 'a', weekEndUS: 'b' }), 'a-b');
  assert.throws(() => render('{{password}}', {}), /Unknown placeholder/);
});

test('customer columns are detected; allowed look-alikes are not', () => {
  const headers = csvHeaderNames('"Order Number","Ship Date","Carrier Fee","Recipient Name","Ship To - Zip","Store Name","Item Name","Buyer Email"\n1,2,3');
  assert.deepEqual(customerHeaders(headers), ['Recipient Name', 'Ship To - Zip', 'Buyer Email']);
  assert.deepEqual(customerHeaders(['Order Number', 'Carrier Fee', 'Insurance Cost', 'Store Name', 'Item Name']), []);
  assert.deepEqual(csvHeaderNames('"A ""x""",B\r\n'), ['A "x"', 'B']);
});

test('local paths stay outside the repository', () => {
  const p = localPaths({ localDir: '/x/sb' });
  assert.equal(p.profile, '/x/sb/profile');
  assert.ok(!localPaths().base.includes('sb-gross-profit'));
});

test('config refuses credential-like keys; the example config passes', () => {
  assert.throws(() => assertNoSecretsInConfig({ loginForm: { password: 'x' } }), /\$\.loginForm\.password/);
  assert.throws(() => assertNoSecretsInConfig({ storageState: { cookies: [] } }), /storageState/);
  assert.throws(() => assertNoSecretsInConfig({ auth: { cookies: [{ name: 'a' }] } }), /cookies/);
  assert.doesNotThrow(() => assertNoSecretsInConfig({ loginForm: { passwordField: 'input' }, credentialTarget: 't' }));
  const example = JSON.parse(fs.readFileSync(new URL('../automation/shipstation-export/config.example.json', import.meta.url)));
  assert.doesNotThrow(() => assertNoSecretsInConfig(example));
});
