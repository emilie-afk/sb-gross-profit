/**
 * deploy_context.py: only production builds and branch deploys of the staging branch read the private cost
 * sources or push a catalog. Deploy Previews (which also receive a branch's branch-specific values), other
 * branch deploys and `netlify dev` build with every private source removed. Synthetic sources only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syntheticSheets } from './fixtures-catalog.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HAVE_PY = spawnSync('python3', ['--version']).status === 0;
const MARK = `PRIVSHEET${Date.now()}`;

const py = (code, env = {}) => execFileSync('python3', ['-c', code], { cwd: REPO, encoding: 'utf8',
  env: { PATH: process.env.PATH, PYTHONPATH: REPO, ...env } });

test('roles: production, the staging branch deploy, local runs, and everything else restricted', { skip: !HAVE_PY }, () => {
  const role = env => py('import deploy_context, os; print(deploy_context.build_role(os.environ))', env).trim();
  assert.equal(role({ CONTEXT: 'production', BRANCH: 'main' }), 'production');
  assert.equal(role({ CONTEXT: 'branch-deploy', BRANCH: 'weekly-automation-phase1' }), 'staging');
  assert.equal(role({}), 'local');
  for (const env of [{ CONTEXT: 'deploy-preview', BRANCH: 'weekly-automation-phase1' }, { CONTEXT: 'deploy-preview', BRANCH: 'gate-hardening-release' },
                     { CONTEXT: 'branch-deploy', BRANCH: 'gate-hardening-release' }, { CONTEXT: 'dev' }, { CONTEXT: 'production-x' }])
    assert.equal(role(env), 'restricted', JSON.stringify(env));
});

test('a restricted build loses every private source and push variable, and prints names only', { skip: !HAVE_PY }, () => {
  const env = { CONTEXT: 'deploy-preview', BRANCH: 'weekly-automation-phase1', MCG_SHEET_URL: `https://docs.google.com/${MARK}/a`, LINDAMAKES_SHEET_URL: `https://x/${MARK}`,
                SB_SKU_ALIAS_URL_2: MARK, HP_SKU_ALIAS_URL: MARK, CATALOG_PUSH_URL: `https://w/${MARK}`, SB_INGEST_SECRET: MARK, GDRIVE_API_KEY: MARK,
                HP_COSTS_FOLDER_ID: MARK, PRODUCT_COSTS_JSON1: '{}', SITE_PASSWORD_UNRELATED: 'kept', VENDOR_MOVE_DATE: '2026-11-01' };
  const out = py(`import deploy_context, os, json
role, removed = deploy_context.apply(os.environ)
left = sorted(k for k in os.environ if '${MARK}' in os.environ.get(k, '') or k.endswith('_SHEET_URL') or k in ('CATALOG_PUSH_URL','SB_INGEST_SECRET','GDRIVE_API_KEY','HP_COSTS_FOLDER_ID','PRODUCT_COSTS_JSON1'))
print(json.dumps({'role': role, 'removed': removed, 'left': left, 'kept': os.environ.get('SITE_PASSWORD_UNRELATED')}))`, env);
  const lines = out.trim().split('\n');
  const r = JSON.parse(lines.at(-1));
  assert.equal(r.role, 'restricted');
  assert.deepEqual(r.left, []);
  assert.equal(r.removed.length, 9);
  assert.equal(r.kept, 'kept', 'unrelated variables stay');
  assert.ok(!lines.slice(0, -1).join('\n').includes(MARK), 'the log line carries names only');
  // Production and the staging branch keep their sources.
  for (const e of [{ CONTEXT: 'production', BRANCH: 'main' }, { CONTEXT: 'branch-deploy', BRANCH: 'weekly-automation-phase1' }, {}]) {
    const k = py(`import deploy_context, os; deploy_context.apply(os.environ); print(os.environ.get('MCG_SHEET_URL', ''))`, { ...e, MCG_SHEET_URL: MARK });
    assert.ok(k.trim().endsWith(MARK), JSON.stringify(e));
  }
});

test('push target: production never pushes to a staging Worker, the staging branch only to one', { skip: !HAVE_PY }, () => {
  const p = (url, role) => py(`import deploy_context; print(deploy_context.push_target_problem(${JSON.stringify(url)}, ${JSON.stringify(role)}) or 'ok')`).trim();
  assert.equal(p('https://sb-gp-worker.acct.workers.dev/v1/ingest/catalog', 'production'), 'ok');
  assert.match(p('https://sb-gp-worker-staging.acct.workers.dev/v1/ingest/catalog', 'production'), /must not push to a staging Worker/);
  assert.equal(p('https://sb-gp-worker-staging.acct.workers.dev/v1/ingest/catalog', 'staging'), 'ok');
  assert.match(p('https://sb-gp-worker.acct.workers.dev/v1/ingest/catalog', 'staging'), /only to a staging Worker/);
  assert.match(p('https://anything', 'restricted'), /may not push/);
  assert.ok(!p('https://sb-gp-worker.acct.workers.dev/secret-path', 'staging').includes('workers.dev'), 'the message never carries the URL');
});

test('build.py in a Deploy Preview: no sheet is read and no cost table is filled, the build still completes', { skip: !HAVE_PY }, () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-ctx-'));
  try {
    for (const f of ['build.py', 'vendor_sheets.py', 'catalog_hook.py', 'deploy_context.py']) fs.copyFileSync(path.join(REPO, f), path.join(work, f));
    const spec = {};
    for (const [k, v] of Object.entries(syntheticSheets())) {
      if (k === 'productExport' || typeof v !== 'string') continue;
      const f = path.join(work, `${k}.src`); fs.writeFileSync(f, v); spec[k] = f;
    }
    const srcJson = path.join(work, 'sources.json');
    fs.writeFileSync(srcJson, JSON.stringify(spec));
    const run = env => execFileSync('python3', [path.join(REPO, 'tools/catalog-parity/run_build.py'), work, srcJson],
      { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
    const read = n => JSON.parse(fs.readFileSync(path.join(work, 'data', `${n}.json`), 'utf8'));

    run({ CONTEXT: 'deploy-preview', BRANCH: 'weekly-automation-phase1' });
    assert.deepEqual(read('product_costs'), {}, 'no HP, Air Plant Shop or Live to Give source was read');
    assert.ok(Object.values(read('vendor_costs')).every(v => Object.keys(v).length === 0), 'no vendor tab was read');
    assert.ok(!Object.keys(read('mcg_total')).some(k => k.startsWith('__n__')), 'no MCG sheet was read (only the built-in lists remain)');

    run({ CONTEXT: 'production', BRANCH: 'main' });
    assert.ok(Object.keys(read('product_costs')).length > 0, 'production reads its sources');
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});
