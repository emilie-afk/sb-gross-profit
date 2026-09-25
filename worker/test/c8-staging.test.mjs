/**
 * C8 — staging isolation and retired-architecture checks. A Worker declares
 * its environment; its D1 database is bound to one environment once, and a
 * Worker never reads or writes a database bound to another. Synthetic data only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import worker from '../src/index.js';
import { makeEnv, ingest, admin, call, catalog, sessionCookie, WEEK } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const rows = async (env, table) => (await env.DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first()).n;
const bind = (env, environment, reason = 'C8 staging acceptance bind (test)') => admin(env, 'POST', '/v1/admin/environment/bind', { environment, reason });

test('C8 isolation: an unbound database refuses writes until bound to the Worker\'s own environment', async () => {
  const env = await makeEnv({ SB_ENVIRONMENT: 'staging' });
  const r = await ingest(env, '/v1/ingest/catalog', catalog());
  assert.deepEqual([r.status, r.json.error], [409, 'database_environment_unbound']);
  assert.equal(await rows(env, 'cost_catalog'), 0);
  assert.equal((await admin(env, 'GET', '/v1/admin/settings')).status, 200, 'reads are allowed while unbound');
  assert.equal((await bind(env, 'production')).status, 400, 'cannot bind to another environment');
  assert.equal((await bind(env, 'staging', 'x')).status, 400, 'a reason is required');
  const b = await bind(env, 'staging');
  assert.deepEqual([b.status, b.json.environment], [200, 'staging']);
  assert.equal((await bind(env, 'staging')).json.alreadyBound, true);
  assert.equal((await ingest(env, '/v1/ingest/catalog', catalog())).status, 200);
  const audit = await env.DB.prepare("SELECT * FROM settings_audit WHERE key = 'database_environment'").first();
  assert.deepEqual([audit.new_value, audit.actor_class], ['"staging"', 'admin_secret']);
  // Not settable through the ordinary settings route.
  assert.equal((await admin(env, 'POST', '/v1/admin/settings', { database_environment: 'production', reason: 'try to re-bind' })).status, 400);
});

test('C8 isolation: a staging Worker pointed at a production-bound D1 reads and writes nothing', async () => {
  const env = await makeEnv({ SB_ENVIRONMENT: 'production' });
  assert.equal((await bind(env, 'production', 'production bind (test)')).status, 200);
  assert.equal((await ingest(env, '/v1/ingest/catalog', catalog())).status, 200);
  const cookie = await sessionCookie(env);
  const before = await Promise.all(['cost_catalog', 'ingest_run', 'settings', 'settings_audit', 'reporting_run', 'schedule_cycle', 'automation_event'].map(t => rows(env, t)));
  // The same database, now reached by a Worker that says it is staging.
  env.SB_ENVIRONMENT = 'staging';
  const attempts = [
    ingest(env, '/v1/ingest/catalog', catalog()),
    ingest(env, '/v1/ingest/shopify', { format: 'csv_text', mode: 'rolling', text: 'x', weekStart: WEEK }),
    admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK }),
    admin(env, 'POST', '/v1/admin/settings', { publication_enabled: true, reason: 'must not land' }),
    admin(env, 'GET', '/v1/admin/settings'),
    call(env, 'GET', `/v1/automation/status?weekStart=${WEEK}`, { cookie }),
    call(env, 'GET', '/v1/weeks', { cookie }),
    bind(env, 'staging'),
  ];
  for (const r of await Promise.all(attempts)) assert.deepEqual([r.status, r.json.error], [503, 'database_environment_mismatch'], JSON.stringify(r.json));
  const tick = await worker.scheduled({ scheduledTime: Date.parse('2026-09-21T08:30:00Z') }, env, null);
  assert.deepEqual(tick, { skipped: 'database_environment_mismatch' });
  const after = await Promise.all(['cost_catalog', 'ingest_run', 'settings', 'settings_audit', 'reporting_run', 'schedule_cycle', 'automation_event'].map(t => rows(env, t)));
  assert.deepEqual(after, before, 'nothing was written');
  const h = await call(env, 'GET', '/v1/health');
  assert.deepEqual([h.status, h.json.environment], [200, 'staging']);
});

test('C8 isolation: wrangler.toml declares each environment, separate D1 databases, and every control off', () => {
  const toml = fs.readFileSync(path.join(REPO, 'worker', 'wrangler.toml'), 'utf8');
  const [prod, staging] = toml.split('[env.staging]');
  assert.match(prod, /SB_ENVIRONMENT = "production"/);
  assert.match(staging, /SB_ENVIRONMENT = "staging"/);
  assert.match(prod, /database_name = "sb-gp"\n/);
  assert.match(staging, /database_name = "sb-gp-staging"/);
  assert.ok(!/database_name = "sb-gp"\n/.test(staging), 'staging never names the production database');
  for (const part of [prod, staging]) {
    assert.match(part, /PUBLICATION_ALLOWED = "false"/);
    assert.match(part, /AUTOMATION_ENABLED = "false"/);
  }
  assert.ok(!/TEST_HOOK|crons\s*=|\[triggers\]/.test(toml));
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(toml), 'no real D1 id committed');
});

test('C8 retired Make: no active document or checklist instructs configuring Make', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' }).split('\n').filter(f => /\.(md|toml|html)$/.test(f));
  const archive = fs.readFileSync(path.join(REPO, 'docs', 'make-scenarios.md'), 'utf8');
  assert.match(archive, /Retired architecture\. Production automation uses the Windows collector and Cloudflare Worker orchestration\./);
  assert.ok(archive.split('\n').length < 20, 'the archive is a short notice only');
  for (const f of tracked) {
    if (f === 'docs/make-scenarios.md') continue;
    const text = fs.readFileSync(path.join(REPO, f), 'utf8');
    assert.ok(!/Make\.com|Make S[0-9]|Make scenario|Make data store|Make connection|in Make\b/.test(text), `${f} still describes Make`);
  }
});
