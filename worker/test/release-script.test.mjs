// The Worker release script (scripts/release.mjs): the generated config's [define] carries the rules exactly,
// as a top-level table (before any [env.*]) and for the chosen environment; the invented test rules are refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatedConfig, loadRules } from '../scripts/release.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYNTH = path.join(HERE, '..', '..', 'tests', 'fixtures', 'private-rules.synthetic.json');
const BASE = fs.readFileSync(path.join(HERE, '..', 'wrangler.toml'), 'utf8');

const defines = text => [...text.matchAll(/^__GP_PRIVATE_RULES__ = (".*")$/mg)].map(m => JSON.parse(JSON.parse(m[1])));

test('release: [define] holds the rules exactly, top-level and for the environment', () => {
  const doc = JSON.parse(fs.readFileSync(SYNTH, 'utf8'));
  const rules = JSON.stringify({ ...doc, version: 'release-test' });
  const prod = generatedConfig(BASE, rules, null);
  assert.ok(prod.indexOf('[define]') < prod.indexOf('[env.staging]'), 'the top-level [define] precedes the environments');
  assert.deepEqual(defines(prod), [JSON.parse(rules)]);
  const staging = generatedConfig(BASE, rules, 'staging');
  assert.deepEqual(defines(staging), [JSON.parse(rules), JSON.parse(rules)]);
  assert.match(staging, /^\[env\.staging\.define\]$/m);
  assert.ok(staging.startsWith('# GENERATED'), 'marked as generated');
  assert.ok(BASE.length && !/__GP_PRIVATE_RULES__/.test(BASE), 'the committed config carries no rules');
});

test('release: invented test rules and invalid files are refused', async () => {
  await assert.rejects(loadRules(SYNTH), /invented test rules/);
  await assert.rejects(loadRules(path.join(HERE, 'no-such-file.json')), /not readable/);
  assert.throws(() => generatedConfig('[define]\nX = "1"\n', '{}', null), /already has a \[define\]/);
});

test('release: the generated config is git-ignored', () => {
  const ignore = fs.readFileSync(path.join(HERE, '..', '..', '.gitignore'), 'utf8');
  assert.match(ignore, /^worker\/wrangler\.release\.toml$/m);
});
