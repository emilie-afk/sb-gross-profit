// Node runtimes (gp-verify, collector, tools): the rules file first, then PRIVATE_RULES_JSON (plain or gz:base64).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { setPrivateRules, privateRules, hasPrivateRules, _clearPrivateRules } from '../shared/privateRules.js';
import { loadPrivateRulesFromFile } from '../shared/privateRulesNode.mjs';

const SYNTH = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'private-rules.synthetic.json'), 'utf8');
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-none-'));
const withRules = (fn) => { const saved = privateRules(); _clearPrivateRules(); const cwd = process.cwd(); process.chdir(empty);
  try { return fn(); } finally { process.chdir(cwd); _clearPrivateRules(); setPrivateRules(saved); } };
// No file anywhere: point the explicit file at a missing path and run from an empty directory.
const ENV = extra => ({ GP_PRIVATE_RULES_FILE: path.join(empty, 'missing.json'), LAMBDA_TASK_ROOT: empty, ...extra });

test('rules from the variable when no file exists: gz:base64 and plain JSON', () => {
  const doc = { ...JSON.parse(SYNTH), version: 'from-variable' };
  withRules(() => {
    // The repository root has no data/private-rules.json in a checkout; skip if a local build left one.
    if (fs.existsSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'private-rules.json'))) return;
    assert.equal(loadPrivateRulesFromFile(ENV({ PRIVATE_RULES_JSON: 'gz:' + gzipSync(Buffer.from(JSON.stringify(doc))).toString('base64') })), true);
    assert.equal(privateRules().version, 'from-variable');
    _clearPrivateRules();
    assert.equal(loadPrivateRulesFromFile(ENV({ PRIVATE_RULES_JSON: JSON.stringify(doc) })), true);
    assert.equal(privateRules().version, 'from-variable');
    _clearPrivateRules();
    assert.throws(() => loadPrivateRulesFromFile(ENV({ PRIVATE_RULES_JSON: 'gz:not-base64-gzip' })), /private_rules_invalid/);
    assert.throws(() => loadPrivateRulesFromFile(ENV({})), /private_rules_missing/);
    assert.equal(hasPrivateRules(), false);
  });
});

test('a rules file wins over the variable', () => {
  const file = path.join(empty, 'rules.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(SYNTH), version: 'from-file' }));
  withRules(() => {
    loadPrivateRulesFromFile({ GP_PRIVATE_RULES_FILE: file, PRIVATE_RULES_JSON: JSON.stringify({ ...JSON.parse(SYNTH), version: 'from-variable' }) });
    assert.equal(privateRules().version, 'from-file');
  });
});
