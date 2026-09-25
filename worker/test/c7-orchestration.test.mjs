/**
 * C7 — weekly orchestration in the Worker. The Cron handler is invoked directly
 * (test-only: AUTOMATION_ENABLED "true" in the test env; wrangler.toml keeps it
 * "false" and configures no cron trigger). Synthetic data only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/index.js';
import { makeEnv, loaded, ingest, admin, call, sessionCookie, viaNormalized, catalog, weekOrders, markShippingSourceVerifiedForTests, WEEK } from './helpers.mjs';
import { reportRow } from '../../tests/fixtures-shipping-cost.mjs';
import { ssCustom, gqlOrder } from '../../tests/fixtures-normalized.mjs';
import { sanitizeShippingCostReport, parseShippingCostReport } from '../../shared/adapters/shippingCostReport.js';
import { toCsvText } from '../../shared/adapters/shopifyCsv.js';
import { retryTimeline, nextRetryAt, pastCutoff, RETRY_POLICY } from '../../shared/schedule.js';
import { canTransition, TRANSITIONS } from '../src/runs.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tick = (env, iso) => worker.scheduled({ scheduledTime: Date.parse(iso) }, env, null);
const count = async (env, table, where = '1=1') => (await env.DB.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).first()).n;
const cycleRow = env => env.DB.prepare('SELECT * FROM schedule_cycle WHERE week_start = ?1').bind(WEEK).first();
const runOf = async env => env.DB.prepare('SELECT * FROM reporting_run WHERE run_id = ?1').bind((await cycleRow(env)).run_id).first();
const updatesScan = env => ingest(env, '/v1/ingest/shopify', viaNormalized({ mode: 'updated_since', nodes: [], weekStart: WEEK }));

/** A report for the loaded week's orders; the first version waits for review unless accepted here. */
async function sendReport(env, nodes, { accept = false, from = WEEK, to = '2026-09-20', costFor = () => '5.10' } = {}) {
  const raw = nodes.map((o, i) => reportRow({ date: `2026-09-${15 + (i % 5)}`, order: o.name.slice(1), cost: costFor(i), paid: '5.00' }));
  const s = sanitizeShippingCostReport(raw);
  const p = parseShippingCostReport(s.rows, { requestedFrom: from, requestedTo: to });
  const r = await ingest(env, '/v1/ingest/shipping-cost-report', { format: 'csv_text', text: toCsvText(s.rows, s.columns), requestedFrom: from, requestedTo: to,
    rowCount: p.rowCount, shippingCostTotal: p.shippingCostCents / 100, exportedAt: '2026-09-21T15:00:00Z' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  if (accept && r.json.status === 'pending_review') assert.equal((await admin(env, 'POST', `/v1/admin/shipping-cost/versions/${r.json.versionId}/accept`, { reason: 'test: reviewed' })).status, 200);
  return r.json;
}
const partial = (opts = {}) => loaded(20, {}, { shippingReport: false, ...opts });      // catalog + Shopify week + mapping export only

// ─── Retry timeline ───────────────────────────────────────────────────────────

test('C7 timeline: collection 15:05, first attempt 15:30, every 15 min to 18:30, hourly to Tuesday 15:30 ICT', () => {
  const t = retryTimeline(WEEK);
  assert.deepEqual([t.collectionAt, t.firstAttemptAt, t.fastUntil, t.cutoffAt],
    ['2026-09-21T08:05:00.000Z', '2026-09-21T08:30:00.000Z', '2026-09-21T11:30:00.000Z', '2026-09-22T08:30:00.000Z']);
  assert.equal(t.attempts.length, 13 + 21);
  assert.deepEqual(t.attempts.slice(0, 2), ['2026-09-21T08:30:00.000Z', '2026-09-21T08:45:00.000Z']);
  assert.deepEqual(t.attempts.slice(12, 14), ['2026-09-21T11:30:00.000Z', '2026-09-21T12:30:00.000Z']);
  assert.equal(t.attempts.at(-1), t.cutoffAt);
  assert.equal(nextRetryAt(WEEK, '2026-09-21T08:31:00Z'), '2026-09-21T08:45:00.000Z');
  assert.equal(nextRetryAt(WEEK, '2026-09-21T11:40:00Z'), '2026-09-21T12:30:00.000Z');
  assert.equal(nextRetryAt(WEEK, '2026-09-22T08:30:00Z'), null);
  assert.equal(pastCutoff(WEEK, '2026-09-22T08:29:59Z'), false);
  assert.equal(pastCutoff(WEEK, '2026-09-22T08:30:00Z'), true);
  assert.deepEqual(RETRY_POLICY, { fastEveryMinutes: 15, fastForMinutes: 180, slowEveryMinutes: 60, cutoffAfterMinutes: 1440 });
  // Winter week (PST): the store week closes an hour later; the ICT schedule does not move.
  const w = retryTimeline('2026-11-02');
  assert.deepEqual([w.collectionAt, w.firstAttemptAt, w.cutoffAt], ['2026-11-09T08:05:00.000Z', '2026-11-09T08:30:00.000Z', '2026-11-10T08:30:00.000Z']);
});

test('C7 state machine: waiting and timeout states have exactly the approved exits', () => {
  assert.deepEqual(TRANSITIONS.waiting_for_sources, ['computing', 'source_timeout', 'cancelled']);
  assert.deepEqual(TRANSITIONS.source_timeout, ['computing', 'cancelled']);
  assert.ok(canTransition('created', 'waiting_for_sources') && canTransition('failed', 'waiting_for_sources'));
  assert.ok(!canTransition('waiting_for_sources', 'draft') && !canTransition('source_timeout', 'published') && !canTransition('waiting_for_sources', 'failed'));
});

// ─── Waiting, retries, resume ─────────────────────────────────────────────────

test('C7: missing sources at 15:30 → one waiting run, no snapshot; retries follow the timeline; arrival resumes the same run', async () => {
  const { env, nodes } = await partial();
  assert.deepEqual(await tick(env, '2026-09-21T08:20:00Z').then(r => r.attempts), [], 'before 15:30 nothing is attempted');
  assert.equal(await count(env, 'schedule_cycle'), 0);

  const first = await tick(env, '2026-09-21T08:30:00Z');
  assert.deepEqual(first.attempts.map(a => [a.state, a.missing]), [['waiting_for_sources', ['shopify_updates:missing', 'shipping_cost_report:missing']]]);
  let c = await cycleRow(env);
  assert.deepEqual([c.status, c.attempts, c.next_retry_at, c.last_attempt_at], ['waiting_for_sources', 1, '2026-09-21T08:45:00.000Z', '2026-09-21T08:30:00.000Z']);
  assert.equal((await runOf(env)).state, 'waiting_for_sources');
  assert.equal(await count(env, 'snapshot'), 0, 'no financial snapshot while waiting');

  assert.deepEqual((await tick(env, '2026-09-21T08:40:00Z')).attempts, [], 'not a retry point and nothing changed');
  await tick(env, '2026-09-21T08:45:00Z');
  c = await cycleRow(env);
  assert.deepEqual([c.attempts, c.next_retry_at], [2, '2026-09-21T09:00:00.000Z']);

  // Shopify's emailed export is still processing: the updated-order scan arrives, the report does not.
  await updatesScan(env);
  const mid = await tick(env, '2026-09-21T08:50:00Z');                 // a change triggers an attempt between retry points
  assert.deepEqual(mid.attempts.map(a => a.missing), [['shipping_cost_report:missing']]);
  assert.equal((await runOf(env)).state, 'waiting_for_sources', 'never failed while a source is still coming');

  await sendReport(env, nodes, { accept: true });
  const done = await tick(env, '2026-09-21T09:05:00Z');
  assert.equal(done.attempts.length, 1);
  const run = await runOf(env);
  assert.ok(['validated', 'blocked'].includes(run.state), run.state);
  assert.equal((await cycleRow(env)).status, 'computed');
  assert.deepEqual([await count(env, 'schedule_cycle'), await count(env, 'reporting_run', "trigger = 'schedule'"), await count(env, 'snapshot')], [1, 1, 1]);
  const trans = (await env.DB.prepare('SELECT from_state, to_state FROM run_transition WHERE run_id = ?1 ORDER BY seq').bind(run.run_id).all()).results.map(t => `${t.from_state}>${t.to_state}`);
  assert.deepEqual(trans.slice(0, 3), ['null>created', 'created>waiting_for_sources', 'waiting_for_sources>computing']);
  for (const iso of ['2026-09-21T09:15:00Z', '2026-09-21T12:30:00Z', '2026-09-22T08:30:00Z']) await tick(env, iso);
  assert.deepEqual([await count(env, 'reporting_run', "trigger = 'schedule'"), await count(env, 'snapshot')], [1, 1], 'later ticks never duplicate');
});

test('C7: after the cutoff the run is source_timeout; a later valid upload resumes the same run into one draft', async () => {
  const { env, nodes } = await partial();
  await updatesScan(env);
  for (const iso of retryTimeline(WEEK).attempts) await tick(env, iso);
  const c = await cycleRow(env);
  assert.deepEqual([c.status, c.next_retry_at, c.timed_out_at, c.attempts], ['source_timeout', null, '2026-09-22T08:30:00.000Z', 34]);
  const run = await runOf(env);
  assert.equal(run.state, 'source_timeout');
  assert.equal(await count(env, 'snapshot'), 0);
  assert.deepEqual((await tick(env, '2026-09-22T09:30:00Z')).attempts, [], 'no retries after the cutoff without a new upload');

  // Wednesday: the report finally arrives. The next tick's current week is still WEEK (last closed week) until Monday.
  await sendReport(env, nodes, { accept: true });
  const r = await tick(env, '2026-09-23T02:00:00Z');
  assert.equal(r.attempts.length, 1);
  const after = await runOf(env);
  assert.equal(after.run_id, run.run_id, 'the same run resumed');
  assert.ok(['validated', 'blocked'].includes(after.state));
  assert.deepEqual([await count(env, 'reporting_run', "trigger = 'schedule'"), await count(env, 'snapshot')], [1, 1]);
  const trans = (await env.DB.prepare('SELECT to_state FROM run_transition WHERE run_id = ?1 ORDER BY seq').bind(run.run_id).all()).results.map(t => t.to_state);
  assert.deepEqual(trans.slice(0, 4), ['created', 'waiting_for_sources', 'source_timeout', 'computing']);

  // An older timed-out cycle is picked up by a later week's tick when its sources change.
  const { env: env2, nodes: n2 } = await partial();
  await updatesScan(env2);
  await tick(env2, '2026-09-22T08:30:00Z');                          // first ever attempt already past the cutoff
  assert.equal((await cycleRow(env2)).status, 'source_timeout');
  await sendReport(env2, n2, { accept: true });
  const later = await tick(env2, '2026-09-28T09:00:00Z');            // next week's first slot
  assert.ok(later.attempts.some(a => a.weekStart === WEEK && ['validated', 'blocked'].includes(a.state)), JSON.stringify(later.attempts));
});

test('C7: never an older source — a report that does not cover the week, or arrived before it closed, keeps it waiting', async () => {
  const { env, nodes } = await partial();
  await updatesScan(env);
  await sendReport(env, nodes.slice(0, 4), { accept: true, from: '2026-09-14', to: '2026-09-18' });   // ends Friday
  const r = await tick(env, '2026-09-21T08:30:00Z');
  assert.deepEqual(r.attempts[0].missing, ['shipping_cost_report:missing']);
  // A full-week report whose import predates the week's close (e.g. an old export re-sent) is not substituted either.
  const v = await sendReport(env, nodes, { accept: true });
  await env.DB.prepare("UPDATE shipping_cost_source_version SET imported_at = '2026-09-20T12:00:00.000Z' WHERE version_id = ?1").bind(v.versionId).run();
  const r2 = await tick(env, '2026-09-21T08:45:00Z');
  assert.deepEqual(r2.attempts[0].missing, ['shipping_cost_report:missing']);
  assert.equal(await count(env, 'snapshot'), 0);
});

// ─── Shipping Cost Report states ──────────────────────────────────────────────

async function computedWith(state) {
  const { env, nodes } = await partial();
  await updatesScan(env);
  await markShippingSourceVerifiedForTests(env);                     // test-only: isolate the report-state rule
  let v = await sendReport(env, nodes);
  if (state === 'pending_review') {
    // An accepted report is active for the week; a newer export with changed costs waits for review.
    assert.equal((await admin(env, 'POST', `/v1/admin/shipping-cost/versions/${v.versionId}/accept`, { reason: 'test: reviewed' })).status, 200);
    await new Promise(r => setTimeout(r, 5));
    v = await sendReport(env, nodes, { costFor: i => (i % 3 ? '5.10' : '6.40') });
    assert.equal(v.status, 'pending_review');
  }
  if (state === 'accepted') assert.equal((await admin(env, 'POST', `/v1/admin/shipping-cost/versions/${v.versionId}/accept`, { reason: 'test: reviewed' })).status, 200);
  if (state === 'rejected') assert.equal((await admin(env, 'POST', `/v1/admin/shipping-cost/versions/${v.versionId}/reject`, { reason: 'test: rejected' })).status, 200);
  const t = await tick(env, '2026-09-21T08:30:00Z');
  return { env, t, run: await runOf(env) };
}

test('C7 report states: accepted computes and passes the report gate; only the publication controls stop it', async () => {
  const { env, run } = await computedWith('accepted');
  assert.equal(run.state, 'validated', run.gate);
  const gate = JSON.parse(run.gate);
  assert.equal(gate.shippingReport.status, 'accepted');
  assert.ok(!gate.warnings.some(w => w.code === 'shipping_report_pending_review'));
  const p = await admin(env, 'POST', '/v1/admin/publish', { snapshotId: run.snapshot_id });
  assert.deepEqual([p.status, p.json.detail?.reason], [409, 'publication_disabled'], 'controls are off; nothing else blocks it');
});

test('C7 report states: pending_review computes a provisional draft but can never publish', async () => {
  const { env, run } = await computedWith('pending_review');
  assert.equal(run.state, 'validated', 'the draft is allowed (computed on the accepted, active report data)');
  const gate = JSON.parse(run.gate);
  assert.equal(gate.shippingReport.status, 'pending_review');
  assert.ok(gate.warnings.some(w => w.code === 'shipping_report_pending_review'));
  assert.equal((await env.DB.prepare('SELECT status FROM snapshot WHERE snapshot_id = ?1').bind(run.snapshot_id).first()).status, 'draft');
  // Even with both publication switches on (test-only), pending review refuses publication.
  await env.DB.prepare("UPDATE settings SET value = 'true' WHERE key = 'publication_enabled'").run();
  env.PUBLICATION_ALLOWED = 'true';
  const p = await admin(env, 'POST', '/v1/admin/publish', { snapshotId: run.snapshot_id });
  assert.deepEqual([p.status, p.json.detail?.reason], [409, 'shipping_report_not_accepted']);
  assert.equal(await count(env, 'snapshot', "status = 'published'"), 0);
});

test('C7 report states: rejected leaves the source missing — no computation, no publication', async () => {
  const { env, t, run } = await computedWith('rejected');
  assert.deepEqual([t.attempts[0].state, t.attempts[0].missing], ['waiting_for_sources', ['shipping_cost_report:missing']]);
  assert.equal(run.state, 'waiting_for_sources');
  assert.equal(await count(env, 'snapshot'), 0);
  // A manual compute of the week is blocked by the report gate.
  const m = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  assert.ok(m.json.gate.failures.some(f => f.code === 'shipping_report_missing'));
  assert.equal(m.json.snapshotStatus, 'blocked');
});

test('C7: the mapping export never satisfies readiness and is financially inert', async () => {
  const { env, nodes } = await partial();
  await updatesScan(env);
  const rows = nodes.flatMap((o, i) => ssCustom({ shipment: `BIG${i}`, order: o.name.slice(1), fee: '999.00', rate: '888.00', insurance: '77.00', paid: '555.00' }));
  assert.equal((await ingest(env, '/v1/ingest/shipstation', { format: 'rows', rows, weekStart: WEEK })).status, 200);
  const t = await tick(env, '2026-09-21T08:30:00Z');
  assert.deepEqual(t.attempts[0].missing, ['shipping_cost_report:missing'], 'mapping export present, still waiting');
  await sendReport(env, nodes, { accept: true });
  await tick(env, '2026-09-21T08:45:00Z');
  const withMapping = (await admin(env, 'GET', `/v1/snapshot/${WEEK}?includeDrafts=1`)).json.totals;
  const { env: e2, nodes: n2 } = await partial();
  await updatesScan(e2); await sendReport(e2, n2, { accept: true }); await tick(e2, '2026-09-21T08:30:00Z');
  const plain = (await admin(e2, 'GET', `/v1/snapshot/${WEEK}?includeDrafts=1`)).json.totals;
  for (const k of ['shipStationExpense', 'shippingExpense', 'operatingGpAfterShipping', 'knownProductCogs']) assert.equal(withMapping[k], plain[k], k);
});

// ─── Catalog ──────────────────────────────────────────────────────────────────

test('C7 catalog: a failed refresh keeps the week waiting until an audited reuse approval; the revision is pinned once', async () => {
  const { env, nodes } = await loaded(20, {}, { shippingReport: false, refresh: false });
  await updatesScan(env);
  await sendReport(env, nodes, { accept: true });
  const rf = (await admin(env, 'POST', '/v1/admin/catalog-refresh', { weekStart: WEEK })).json.refreshId;
  const shrunk = catalog({ calathea: 300 }); shrunk.meta.refreshId = rf;
  assert.equal((await ingest(env, '/v1/ingest/catalog', shrunk)).json.refresh.status, 'rejected', 'a failed refresh activates nothing');
  const t = await tick(env, '2026-09-21T08:30:00Z');
  assert.deepEqual(t.attempts[0].missing, ['catalog_refresh:rejected']);
  assert.equal((await admin(env, 'POST', `/v1/admin/cycles/${WEEK}/accept-catalog-reuse`, { reason: 'short' })).status, 400);
  const ok = await admin(env, 'POST', `/v1/admin/cycles/${WEEK}/accept-catalog-reuse`, { reason: 'Sheets unchanged this week; reuse the pinned catalog (test)' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  await tick(env, '2026-09-21T08:35:00Z');                            // the approval is a change → attempted
  const run = await runOf(env);
  assert.ok(['validated', 'blocked'].includes(run.state));
  const gate = JSON.parse(run.gate);
  assert.equal(gate.catalog.freshness.status, 'reused_accepted');
  assert.ok(gate.warnings.some(w => w.code === 'catalog_reused'));
  const pinned = run.catalog_rev;
  // A newer catalog becomes active, but a recompute of the scheduled run keeps its pinned revision.
  assert.equal((await ingest(env, '/v1/ingest/catalog', catalog({ calathea: 470 }))).json.accepted, true);
  const re = await admin(env, 'POST', `/v1/admin/runs/${run.run_id}/compute`, { reason: 'retry (test)' });
  assert.equal(re.status, 200, JSON.stringify(re.json));
  const s = (await admin(env, 'GET', `/v1/snapshot/${WEEK}?includeDrafts=1`)).json;
  assert.equal(s.catalogRev, pinned);
});

// ─── Updated historical orders ────────────────────────────────────────────────

test('C7: an earlier order changed by the rolling export drafts a traced revision; published history is never touched', async () => {
  const { env, nodes } = await partial();
  const PREV = '2026-09-07';
  const prevOrder = gqlOrder({ name: '#980001', createdAt: '2026-09-08T17:00:00Z', subtotal: 20, shipping: 5, total: 25, lines: [{ sku: 'MG-ALOE', price: 10, qty: 2, vendor: 'Succulents Box' }] });
  assert.equal((await ingest(env, '/v1/ingest/shopify', viaNormalized({ nodes: [prevOrder], weekStart: PREV }))).status, 200);
  const prev = await admin(env, 'POST', '/v1/admin/runs', { weekStart: PREV });
  assert.equal(prev.status, 200);
  const before = (await env.DB.prepare('SELECT snapshot_id, status FROM snapshot WHERE week_start = ?1').bind(PREV).all()).results;

  // This cycle's rolling export (csv_text, hashed) carries the refunded earlier order.
  const { csvOrder } = await import('../../tests/fixtures-normalized.mjs');
  const { sanitizeShopifyOrderRows } = await import('../../shared/adapters/shopifyCsv.js');
  const rows = [...csvOrder({ name: '#980001', createdAt: '2026-09-08 10:00:00 -0700', subtotal: 20, shipping: 5, total: 25, refunded: 5, lines: [{ sku: 'MG-ALOE', price: 10, qty: 2, vendor: 'Succulents Box' }] })];
  const s = sanitizeShopifyOrderRows(rows);
  const up = await ingest(env, '/v1/ingest/shopify', { format: 'csv_text', mode: 'rolling', text: toCsvText(s.rows, s.columns), weekStart: WEEK });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.deepEqual(up.json.weeksTouched, { [PREV]: 1 });
  await sendReport(env, nodes, { accept: true });
  const t = await tick(env, '2026-09-21T08:30:00Z');
  assert.equal(t.revisions.length, 1, JSON.stringify(t));
  assert.equal(t.revisions[0].weekStart, PREV);
  const rev = await env.DB.prepare("SELECT reason, state FROM reporting_run WHERE week_start = ?1 AND trigger = 'source_update'").bind(PREV).first();
  assert.match(rev.reason, new RegExp(`source sha256 ${up.json.sourceHash.slice(0, 16)}`));
  const after = (await env.DB.prepare('SELECT snapshot_id, status FROM snapshot WHERE week_start = ?1 ORDER BY revision').bind(PREV).all()).results;
  assert.deepEqual(after.slice(0, before.length), before, 'the earlier revision is untouched');
  assert.equal(after.length, before.length + 1);
  assert.ok(after.every(x => x.status !== 'published'));
  assert.deepEqual((await tick(env, '2026-09-21T08:45:00Z')).revisions, [], 'idempotent: already revised');
});

// ─── Concurrency: retries while uploads arrive ────────────────────────────────

test('C7 concurrency: parallel ticks, admin schedule calls and uploads → one cycle, one run, one snapshot', async () => {
  const { env, nodes } = await partial();
  await tick(env, '2026-09-21T08:30:00Z');
  const burst = [];
  for (let i = 0; i < 6; i++) burst.push(tick(env, '2026-09-21T08:45:00Z'));
  for (let i = 0; i < 3; i++) burst.push(admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK, trigger: 'schedule' }));
  burst.push(updatesScan(env));
  burst.push(sendReport(env, nodes, { accept: true }));
  await Promise.all(burst);
  for (let i = 0; i < 3; i++) await Promise.all([tick(env, '2026-09-21T09:00:00Z'), tick(env, '2026-09-21T09:00:00Z'), admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK, trigger: 'schedule' })]);
  assert.deepEqual([await count(env, 'schedule_cycle'), await count(env, 'reporting_run', "trigger = 'schedule'"), await count(env, 'snapshot')], [1, 1, 1]);
  assert.ok(['validated', 'blocked'].includes((await runOf(env)).state));
  assert.equal(await count(env, 'automation_lease'), 0, 'every lease released');
});

// ─── Status, controls ─────────────────────────────────────────────────────────

test('C7 status: sessions see schedule, attempts, sources and labels — no paths, emails, tokens or sheet configuration', async () => {
  const MARK = `PRIVSHEET${crypto.randomUUID().replace(/-/g, '')}`;
  const { env } = await partial();
  env.CATALOG_SOURCES_JSON = JSON.stringify({ L2G_SHEET_URL: `https://docs.google.com/spreadsheets/d/${MARK}/export?format=csv&gid=1` });
  await tick(env, '2026-09-21T08:30:00Z');
  const cookie = await sessionCookie(env);
  const r = await call(env, 'GET', `/v1/automation/status?weekStart=${WEEK}`, { cookie });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const s = r.json;
  assert.deepEqual([s.schedule.collectionAt, s.schedule.firstAttemptAt, s.schedule.cutoffAt], ['2026-09-21T08:05:00.000Z', '2026-09-21T08:30:00.000Z', '2026-09-22T08:30:00.000Z']);
  assert.deepEqual([s.cycle.status, s.cycle.lastAttemptAt, s.cycle.nextRetryAt, s.sourceTimeout], ['waiting_for_sources', '2026-09-21T08:30:00.000Z', '2026-09-21T08:45:00.000Z', false]);
  assert.deepEqual(s.sources.missing, ['shopify_updates:missing', 'shipping_cost_report:missing']);
  assert.ok(s.sources.received.includes('shopify'));
  assert.equal(s.run.state, 'waiting_for_sources');
  assert.equal(s.shippingVerification, 'unverified');
  assert.equal(s.cycle.runId, undefined, 'internal ids are admin-only');
  const text = JSON.stringify(s);
  for (const bad of [MARK, env.INGEST_SECRET, env.ADMIN_SECRET, 'docs.google', '@', 'LOCALAPPDATA', 'C:\\\\']) assert.ok(!text.includes(bad), bad);
  assert.equal((await call(env, 'GET', `/v1/automation/status?weekStart=${WEEK}`)).status, 401, 'a session is required');
  const a = await admin(env, 'GET', `/v1/admin/cycles/${WEEK}`);
  assert.ok(a.json.cycle.runId && a.json.events.length >= 1);
});

test('C7 controls: the tick does nothing unless AUTOMATION_ENABLED is "true"; wrangler.toml keeps it false with no cron trigger', async () => {
  const { env } = await partial();
  env.AUTOMATION_ENABLED = 'false';
  assert.deepEqual(await tick(env, '2026-09-21T08:30:00Z'), { skipped: 'automation_disabled' });
  assert.deepEqual([await count(env, 'schedule_cycle'), await count(env, 'automation_event')], [0, 0]);
  const toml = fs.readFileSync(path.join(HERE, '..', 'wrangler.toml'), 'utf8');
  assert.ok(!/^\s*\[triggers\]/m.test(toml) && !/crons\s*=/.test(toml), 'no cron trigger configured');
  assert.equal((toml.match(/AUTOMATION_ENABLED\s*=\s*"false"/g) || []).length, 2);
  assert.equal((toml.match(/PUBLICATION_ALLOWED\s*=\s*"false"/g) || []).length, 2);
  assert.ok(!/TEST_HOOK/.test(toml));
  const s = (await admin(env, 'GET', '/v1/admin/settings')).json.settings;
  assert.deepEqual([s.shipping_cost_report_source_verified, s.provisional_publication_enabled, s.publication_enabled], [false, false, false]);
});

test('C7: the collector week plan says what the last closed week still lacks (codes only)', async () => {
  const { env, nodes } = await partial();
  const plan = async () => (await call(env, 'GET', '/v1/ingest/week-plan?at=2026-09-21T08:05:00Z', { headers: { 'X-Ingest-Secret': env.INGEST_SECRET } })).json;
  let p = await plan();
  assert.deepEqual([p.weekStart, p.collected, p.collectionComplete], [WEEK, { shopify: 'ok', shopify_updates: 'missing', shipping_cost_report: 'missing' }, false]);
  await updatesScan(env); await sendReport(env, nodes);
  p = await plan();
  assert.deepEqual([p.collected, p.collectionComplete], [{ shopify: 'ok', shopify_updates: 'ok', shipping_cost_report: 'ok' }, true]);
  assert.equal(p.shopify, undefined, 'no Shopify API search strings');
});
