/**
 * privateRulesNode.mjs — loads the private rules file in Node runtimes
 * ====================================================================
 * Used by the gp-verify functions, the Windows collector and the tools. Never
 * imported by the browser or the Worker (they register rules their own way).
 *
 * Search order: GP_PRIVATE_RULES_FILE, then data/private-rules.json under the
 * Lambda task root, the current directory and the repository root, then the
 * PRIVATE_RULES_JSON variable (plain JSON, or "gz:" + base64 of the gzipped JSON:
 * the functions-only verifier site has no build to write the file).
 * Errors name the problem only, never a value or a full path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { setPrivateRules, hasPrivateRules } from './privateRules.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function privateRulesCandidates(env = process.env) {
  const out = [];
  if (env.GP_PRIVATE_RULES_FILE) out.push(env.GP_PRIVATE_RULES_FILE);
  for (const base of [env.LAMBDA_TASK_ROOT, process.cwd(), REPO_ROOT]) {
    if (base) out.push(path.join(base, 'data', 'private-rules.json'));
  }
  return out;
}

/** Registers the rules from the first file found. Throws `private_rules_missing` when none exists. */
export function loadPrivateRulesFromFile(env = process.env) {
  if (hasPrivateRules()) return true;
  for (const file of privateRulesCandidates(env)) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    setPrivateRules(text);
    return true;
  }
  const v = String(env.PRIVATE_RULES_JSON || '').trim();
  if (v) {
    let text;
    try { text = v.startsWith('gz:') ? gunzipSync(Buffer.from(v.slice(3), 'base64')).toString('utf8') : v; }
    catch { throw new Error('private_rules_invalid'); }
    setPrivateRules(text);
    return true;
  }
  throw new Error('private_rules_missing');
}
