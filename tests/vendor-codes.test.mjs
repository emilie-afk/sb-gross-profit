// Vendor codes (shared/vendors.js): the code names vendors by code; full names come from the private legend.
// Weeks and settings saved before the codes are read through the legend and the legacy names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateRules } from '../shared/privateRules.js';
import { APS, LR, HPD, L2G, CC, vendorName, vendorCodeOf, toCode, legacyName, readLegacy } from '../shared/vendors.js';
import { calculate } from '../shared/calculator.js';
import { canonicalVendor } from '../shared/vendorCosts.js';
import { settingsFromRows } from '../worker/src/db.js';
import { parseSources } from '../worker/src/catalogFetch.js';
import { row } from './fixtures.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const L = () => privateRules().vendorLegend;

test('legend: code ↔ full name; unknown names and codes pass through', () => {
  assert.equal(vendorName(CC), L()[CC]);
  assert.equal(vendorCodeOf(L()[APS]), APS);
  assert.equal(toCode(L()[LR]), LR);
  assert.equal(toCode('Some Other Vendor'), 'Some Other Vendor');
  assert.equal(vendorName('ZZ'), 'ZZ');
  assert.equal(vendorCodeOf(''), '');
});

test('stores come out as codes when Shopify spells the full vendor name', () => {
  const lines = calculate([
    row({ Name: '#930001', 'Lineitem sku': 'AS-1', Vendor: L()[APS], 'Lineitem price': '10', Subtotal: '40', Total: '40' }),
    row({ Name: '#930001', 'Lineitem sku': 'HPX-1', Vendor: L()[HPD], 'Lineitem price': '10' }),
    row({ Name: '#930001', 'Lineitem sku': 'QLR_FERN_4IN1', Vendor: L()[LR], 'Lineitem price': '10' }),
    row({ Name: '#930001', 'Lineitem sku': 'X-1', Vendor: L()[CC], 'Lineitem price': '10' }),
  ], new Map(), {}, {}, {}, {}, {}, {}, null, {}, null, null, {});
  assert.deepEqual(lines.map(l => l.store), [APS, HPD, LR, CC]);
  assert.ok(lines.every(l => !Object.values(L()).includes(l.store)), 'no full name in the output');
});

test('catalog vendor from a Shopify spelling (private aliases) or from the code itself', () => {
  assert.equal(canonicalVendor(L()[L2G]), L2G);
  assert.equal(canonicalVendor(L2G), L2G);
  assert.equal(canonicalVendor('nobody at all'), '');
});

test('Worker settings saved under a pre-code name, or keyed by full vendor names, still apply', () => {
  const old = legacyName('lr_cost_source');
  assert.ok(old && old !== 'lr_cost_source');
  const s = settingsFromRows([{ key: old, value: '"sheet"' },
    { key: 'vendor_first_paid_shipping_dates', value: JSON.stringify({ [L()[APS]]: '2026-08-14', [L2G]: '2026-09-15' }) }]);
  assert.equal(s.lr_cost_source, 'sheet');
  assert.equal(s[old], undefined, 'the old key is not carried along');
  assert.deepEqual(s.vendor_first_paid_shipping_dates, { [APS]: '2026-08-14', [L2G]: '2026-09-15' });
  assert.equal(settingsFromRows([{ key: old, value: '"sheet"' }, { key: 'lr_cost_source', value: '"manual_list"' }]).lr_cost_source, 'manual_list', 'the new name wins');
});

test('catalog sources saved under pre-code names are read under the new names', () => {
  const old = legacyName('LG_SHEET_URL');
  const out = parseSources(JSON.stringify({ [old]: 'https://docs.google.com/spreadsheets/d/x/export?format=csv' }));
  assert.equal(out.LG_SHEET_URL, 'https://docs.google.com/spreadsheets/d/x/export?format=csv');
  assert.equal(out[old], undefined);
});

test('stored diagnostics: a field saved under its pre-code name is read', () => {
  assert.deepEqual(readLegacy({ [legacyName('lr')]: { comparison: { identical: true } } }, 'lr'), { comparison: { identical: true } });
  assert.deepEqual(readLegacy({ lr: 1, [legacyName('lr')]: 2 }, 'lr'), 1);
});

test('build.py: a source set under its pre-code variable name is used (private_rules.py)', () => {
  const out = execFileSync('python3', ['-c', `
import json, os, sys
sys.path.insert(0, ${JSON.stringify(REPO)})
import private_rules
doc = json.load(open(${JSON.stringify(path.join(REPO, 'tests/fixtures/private-rules.synthetic.json'))}))
env = {'PRIVATE_RULES_JSON': json.dumps(doc), doc['legacyNames']['LG_SHEET_URL']: 'https://example.invalid/x'}
private_rules.OUTPUTS = ()
private_rules.load(env, 'local')
print(env.get('LG_SHEET_URL'))`], { encoding: 'utf8' });
  assert.match(out.trim().split('\n').pop(), /^https:\/\/example\.invalid\/x$/);
});
