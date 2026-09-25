/**
 * Opt-in adversarial concurrency test on REAL D1 (Miniflare 3 / workerd).
 *
 *   cd worker && npm install && node test/workerd-adversarial.mjs
 *
 * The bundled Worker runs with a test-only TEST_HOOK service binding (a Node
 * function here) and TEST_HOOKS_ENABLED = "true" — neither exists in
 * wrangler.toml. The Worker calls the hook at schedule:before_final_txn and
 * schedule:after_final_txn; the hook changes the claim, stalls the owner, or
 * starts a competing request, exactly at those points.
 *
 * Cases (Revision 8):
 *   A  claim changes before the snapshot transaction   → old owner writes nothing
 *   B  claim changes right after the transaction        → snapshot and final state were one commit; no later write
 *   C  draft vs validated/blocked                       → both recorded in the same commit
 *   D  old owner continues after a new owner completed  → one cycle/run/snapshot, loser changed nothing
 *   B/C rollback: the final statement fails (injected trigger) → snapshot, child rows and both transitions roll back
 *   F  admin recompute vs a stalled scheduled owner      → recompute takes the claim; stalled owner writes nothing
 *   G  run changed underneath the owner (claim unchanged) → final transaction refused
 *   E  takeover races the commit (both orders, repeated) → exactly one owner completes; D1 consistent
 *   H  (C7) Cron ticks + scheduled calls + collector uploads in parallel → one cycle/run/snapshot
 *   I  (C7) an upload, a tick and a scheduled call while the owner commits → owner completes; one snapshot
 *   J  (C7) source_timeout, then a late upload resumes the same run via the Cron tick
 * Synthetic data only.
 */
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
// Tests post synthetic GraphQL-shaped orders through the normalized path (no Shopify API route exists).
import { normalizeShopifyOrders as __norm } from '../../shared/adapters/shopifyGraphql.js';
const viaNormalized = ({ nodes, ...rest }) => ({ format: 'normalized', orders: __norm(nodes, { timeZone: 'America/Los_Angeles' }), storeTimezone: 'America/Los_Angeles', ...rest });

import { fileURLToPath } from 'node:url';
import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { hashPassword } = await import(REPO + '/worker/src/auth.js');
const { gqlOrder, ssCustom } = await import(REPO + '/tests/fixtures-normalized.mjs');
const { reportRow } = await import(REPO + '/tests/fixtures-shipping-cost.mjs');
const { sanitizeShippingCostReport, parseShippingCostReport } = await import(REPO + '/shared/adapters/shippingCostReport.js');
const { toCsvText } = await import(REPO + '/shared/adapters/shopifyCsv.js');

const rnd = () => crypto.randomUUID() + crypto.randomUUID();
const S = { INGEST_SECRET: rnd(), ADMIN_SECRET: rnd(), SESSION_SIGNING_KEY: rnd(), DASHBOARD_PASSWORD_HASH: await hashPassword('synthetic-' + rnd(), { iterations: 1000 }) };
const I = { 'X-Ingest-Secret': S.INGEST_SECRET }, A = { 'X-Admin-Secret': S.ADMIN_SECRET };
const W = '2026-09-14';
const STALE_MS = 400;                                    // test-only stale limit (TEST_STALE_MS)
const stall = () => new Promise(r => setTimeout(r, STALE_MS + 100));   // time passes; the run itself is untouched
const bundle = (await build({ entryPoints: [path.join(REPO, 'worker/src/index.js')], bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', write: false })).outputFiles[0].text;
const v = (n, c) => Object.fromEntries(Array.from({ length: c }, (_, i) => [`${n}-${i}`, { unitCost: 1 }]));
const catalog = { tables: { mcg_total: { P: 1 }, product_costs: {}, sku_weights: {}, sb_costs: {}, hp_supplement: { 'MG-ALOE': 4.5 }, hp_by_name: {}, sku_alias: {},
  vendor_costs: { 'Live to Give': v('L', 30), 'Lively Good': v('G', 171), 'Calathea Collective': v('C', 462), 'Surfside Arrangement': v('S', 11), 'LindaMakes': v('M', 396) },
  vendor_index: { x: {} } } };
const nodes = [], ship = [];
for (let i = 0; i < 30; i++) {
  const name = `#6${String(i).padStart(5, '0')}`;
  nodes.push(gqlOrder({ name, createdAt: `2026-09-${15 + (i % 5)}T18:00:00Z`, subtotal: 20, shipping: 5, total: 25, lines: [{ sku: 'MG-ALOE', price: 10, qty: 2, vendor: 'Succulents Box' }] }));
  ship.push(...ssCustom({ shipment: `Q${i}`, order: name.slice(1), fee: '5.10', rate: '5.40' }));
}

/** A fresh Worker + real D1 whose hook calls `ctx.on(point, data)`. */
async function world({ partial = false } = {}) {
  const ctx = { on: async () => {} };
  const mf = new Miniflare({ modules: true, script: bundle, compatibilityDate: '2024-09-01', d1Databases: ['DB'],
    serviceBindings: { TEST_HOOK: async req => { await ctx.on(new URL(req.url).pathname.slice(1), await req.json()); return new Response('ok'); } },
    bindings: { ...S, ALLOWED_ORIGINS: 'https://sb-profit.netlify.app', COOKIE_SAMESITE: 'Strict', PUBLICATION_ALLOWED: 'false', AUTOMATION_ENABLED: 'true',
                D1_QUOTA_BYTES: '5000000000', TEST_HOOKS_ENABLED: 'true', TEST_STALE_MS: String(STALE_MS) } });
  const db = await mf.getD1Database('DB');
  for (const f of fs.readdirSync(REPO + '/worker/migrations').sort()) {
    const sql = fs.readFileSync(path.join(REPO, 'worker/migrations', f), 'utf8').split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
    await db.batch(sql.split(/;\s*\n/).map(x => x.trim()).filter(Boolean).map(x => db.prepare(x)));
  }
  const call = async (method, p, { body, headers = {} } = {}) => {
    const r = await mf.dispatchFetch('https://w.example' + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, json: j };
  };
  await call('POST', '/v1/admin/settings', { body: { carrier_fee_priority_locked: true, reason: 'adversarial test only' }, headers: A });
  const rf = (await call('POST', '/v1/admin/catalog-refresh', { body: { weekStart: W }, headers: A })).json.refreshId;
  await call('POST', '/v1/ingest/catalog', { body: { ...catalog, meta: { refreshId: rf } }, headers: I });
  await call('POST', '/v1/ingest/shopify', { body: viaNormalized({ mode: 'week', nodes, weekStart: W }), headers: I });
  await call('POST', '/v1/ingest/shipstation', { body: { format: 'rows', rows: ship, weekStart: W }, headers: I });
  // C3: the expense source (every order has a row, so coverage is complete).
  const updates = () => call('POST', '/v1/ingest/shopify', { body: viaNormalized({ mode: 'updated_since', nodes: [], weekStart: W }), headers: I });
  const report = async () => {
    const rs = sanitizeShippingCostReport(nodes.map((n, i) => reportRow({ date: `2026-09-${15 + (i % 5)}`, order: n.name.slice(1), cost: '5.10' })));
    const rp = parseShippingCostReport(rs.rows, { requestedFrom: W, requestedTo: '2026-09-20' });
    const rep = await call('POST', '/v1/ingest/shipping-cost-report', { body: { format: 'csv_text', text: toCsvText(rs.rows, rs.columns), requestedFrom: W, requestedTo: '2026-09-20',
      rowCount: rp.rowCount, shippingCostTotal: rp.shippingCostCents / 100, exportedAt: '2026-09-21T15:00:00Z' }, headers: I });
    if (rep.json?.status === 'pending_review') await call('POST', `/v1/admin/shipping-cost/versions/${rep.json.versionId}/accept`, { body: { reason: 'adversarial test only' }, headers: A });
    return rep;
  };
  // C7: `partial` leaves the updated-order scan and the report for the test to deliver mid-retry.
  if (!partial) { await updates(); await report(); }
  // Test-only stand-in for the future source-verification checklist, so runs reach `validated`.
  await db.prepare("UPDATE settings SET value = 'true' WHERE key = 'shipping_cost_report_source_verified'").run();
  const schedule = (label, at) => call('POST', '/v1/admin/runs', { body: { weekStart: W, trigger: 'schedule', actorLabel: label, ...(at ? { at } : {}) }, headers: A });
  const fetcher = await mf.getWorker();
  const tick = at => fetcher.scheduled({ scheduledTime: new Date(at) });
  const q = async (sql, ...p) => (await db.prepare(sql).bind(...p).all()).results;
  const digest = async () => JSON.stringify(await Promise.all(['reporting_run', 'run_transition', 'snapshot', 'snapshot_totals', 'snapshot_order', 'schedule_cycle']
    .map(t => q(`SELECT * FROM ${t} ORDER BY 1, 2`))));
  const consistent = async () => {
    const runs = await q("SELECT * FROM reporting_run WHERE trigger = 'schedule'");
    const snaps = await q('SELECT snapshot_id FROM snapshot');
    const tr = await q('SELECT seq, to_state FROM run_transition WHERE run_id = ?1 ORDER BY seq', runs[0]?.run_id ?? '');
    const dupSeq = (await q('SELECT run_id, seq, COUNT(*) AS n FROM run_transition GROUP BY run_id, seq HAVING n > 1')).length;
    return { cycles: (await q('SELECT * FROM schedule_cycle')).length, runs: runs.length, snapshots: snaps.length,
             orphans: snaps.filter(s => s.snapshot_id !== runs[0]?.snapshot_id).length, dupSeq,
             contiguous: tr.every((t, i) => t.seq === i), state: runs[0]?.state, stuck: runs.filter(r => ['created', 'computing'].includes(r.state)).length };
  };
  return { mf, db, ctx, schedule, digest, consistent, q, updates, report, tick };
}
const expectDone = (c, label) => assert.deepEqual([c.cycles, c.runs, c.snapshots, c.orphans, c.dupSeq, c.contiguous, c.state, c.stuck],
  [1, 1, 1, 0, 0, true, 'validated', 0], `${label}: ${JSON.stringify(c)}`);
const log = (...a) => console.log(...a);

// A ─────────────────────────────────────────────────────────────────────────
{
  const w = await world(); let atLoss;
  w.ctx.on = async point => { if (point !== 'schedule:before_final_txn') return;
    await w.db.prepare("UPDATE schedule_cycle SET claim_token = 'clm_someone_else'").run(); atLoss = await w.digest(); };
  const r = await w.schedule('make:A');
  assert.deepEqual([r.status, r.json?.error], [409, 'ownership_lost']);
  assert.equal(await w.digest(), atLoss);
  const c = await w.consistent();
  assert.deepEqual([c.snapshots, c.state], [0, 'computing']);
  log('A  claim changed before the snapshot transaction: old owner got ownership_lost; snapshots 0; nothing written after the loss');
  await w.mf.dispose();
}
// B ─────────────────────────────────────────────────────────────────────────
{
  const w = await world(); let atCommit, atLoss;
  w.ctx.on = async point => { if (point !== 'schedule:after_final_txn') return;
    atCommit = await w.consistent();
    await w.db.prepare("UPDATE schedule_cycle SET claim_token = 'clm_someone_else'").run(); atLoss = await w.digest(); };
  const r = await w.schedule('make:B');
  assert.equal(r.status, 200);
  expectDone(atCommit, 'B at commit');
  assert.equal(await w.digest(), atLoss);
  log('B  claim changed right after the transaction: snapshot + run state were already committed together; no write after the loss');
  await w.mf.dispose();
}
// C ─────────────────────────────────────────────────────────────────────────
{
  const w = await world(); const seen = [];
  w.ctx.on = async point => seen.push([point, (await w.q("SELECT state FROM reporting_run WHERE trigger = 'schedule'"))[0].state,
    (await w.q("SELECT 1 FROM run_transition WHERE to_state IN ('draft','validated','blocked')")).length]);
  await w.schedule('make:C');
  assert.deepEqual(seen, [['schedule:before_final_txn', 'computing', 0], ['schedule:after_final_txn', 'validated', 2]]);
  const tr = await w.q("SELECT seq, at FROM run_transition WHERE to_state IN ('draft','validated') ORDER BY seq");
  assert.ok(tr[1].seq === tr[0].seq + 1 && tr[0].at === tr[1].at);
  log('C  draft and validated: absent before the commit, both present after it (consecutive seq, same timestamp); never observable apart');
  await w.mf.dispose();
}
// D ─────────────────────────────────────────────────────────────────────────
{
  const w = await world(); let first = null, winner, afterWinner;
  w.ctx.on = async (point, d) => { if (point !== 'schedule:before_final_txn' || first) return; first = d.token;
    await stall();
    winner = await w.schedule('make:D-new-owner'); afterWinner = await w.digest(); };
  const loser = await w.schedule('make:D-old-owner');
  assert.deepEqual([winner.status, winner.json.resumed, loser.status, loser.json?.error], [200, true, 409, 'ownership_lost']);
  assert.equal(await w.digest(), afterWinner, 'losing owner changed nothing');
  expectDone(await w.consistent(), 'D');
  const again = await w.schedule('make:D-retry');
  assert.equal(again.json.existing, true);
  log('D  old owner continued after the new owner completed: new owner resumed + validated; old owner ownership_lost; 1 cycle / 1 run / 1 snapshot, no orphan, no duplicate seq, loser changed nothing');
  await w.mf.dispose();
}
// B/C on real D1: make the LAST statement of the final transaction fail (a
// trigger on the run update). Everything before it — snapshot, child rows,
// both transitions — must roll back with it.
{
  const w = await world(); let armed = true;
  w.ctx.on = async point => { if (point !== 'schedule:before_final_txn' || !armed) return; armed = false;
    await w.db.exec("CREATE TRIGGER inject_fail BEFORE UPDATE OF state ON reporting_run WHEN NEW.state = 'validated' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;"); };
  const r = await w.schedule('make:BC-rollback');
  assert.equal(r.status, 500);
  const snaps = (await w.q('SELECT 1 FROM snapshot')).length, totals = (await w.q('SELECT 1 FROM snapshot_totals')).length;
  const drafts = (await w.q("SELECT 1 FROM run_transition WHERE to_state IN ('draft','validated')")).length;
  assert.deepEqual([snaps, totals, drafts], [0, 0, 0]);
  await w.db.exec('DROP TRIGGER inject_fail;');
  const again = await w.schedule('make:BC-resume');
  assert.deepEqual([again.status, again.json.resumed, again.json.state], [200, true, 'validated']);
  expectDone(await w.consistent(), 'BC resume');
  log('B/C real-D1 rollback: a failure in the final statement rolled back the snapshot, its child rows and both transitions; the cycle then resumed cleanly');
  await w.mf.dispose();
}
// Admin recompute vs a stalled scheduled owner ───────────────────────────────
{
  const w = await world(); let adminRun, afterAdmin, entered = false;
  w.ctx.on = async (point, d) => { if (point !== 'schedule:before_final_txn' || entered) return; entered = true;
    await stall();
    const r = await w.mf.dispatchFetch(`https://w.example/v1/admin/runs/${d.runId}/compute`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...A },
      body: JSON.stringify({ reason: 'operator recompute (test)' }) });
    adminRun = { status: r.status, json: await r.json() }; afterAdmin = await w.digest(); };
  const owner = await w.schedule('make:F-owner');
  assert.deepEqual([adminRun.status, adminRun.json.state, owner.status, owner.json?.error], [200, 'validated', 409, 'ownership_lost']);
  assert.equal(await w.digest(), afterAdmin);
  expectDone(await w.consistent(), 'F');
  log('F  admin recompute of a stalled scheduled run took the claim first; the stalled owner got ownership_lost and wrote nothing');
  await w.mf.dispose();
}
// G: the run bounced by another writer (claim unchanged) → the final transaction refuses
{
  const w = await world(); let atBounce;
  const RUN_TABLES = ['reporting_run', 'run_transition', 'snapshot', 'snapshot_totals', 'snapshot_order'];
  const runDigest = async () => JSON.stringify(await Promise.all(RUN_TABLES.map(t => w.q(`SELECT * FROM ${t} ORDER BY 1, 2`))));
  w.ctx.on = async (point, d) => { if (point !== 'schedule:before_final_txn') return;
    await w.db.prepare("UPDATE reporting_run SET state = 'computing', updated_at = ?2 WHERE run_id = ?1").bind(d.runId, new Date(Date.now() + 1000).toISOString()).run();
    atBounce = await runDigest(); };
  const r = await w.schedule('make:G');
  assert.deepEqual([r.status, r.json?.error], [409, 'concurrent_transition']);
  assert.equal(await runDigest(), atBounce);
  log('G  run changed underneath the owner (same state, new updated_at): final transaction refused; no run/snapshot row written');
  await w.mf.dispose();
}
// E ─────────────────────────────────────────────────────────────────────────
const tally = {};
for (const variant of ['owner_commits_first', 'takeover_claims_first']) {
  for (let i = 0; i < 5; i++) {
    const w = await world(); let first = null, racer;
    w.ctx.on = async (point, d) => { if (point !== 'schedule:before_final_txn' || first) return; first = d.token;
      await stall();
      racer = w.schedule('make:E-racer');
      if (variant === 'takeover_claims_first') {
        for (let k = 0; k < 400; k++) {
          if ((await w.q('SELECT claim_token FROM schedule_cycle'))[0].claim_token !== d.token) break;
          await new Promise(r => setTimeout(r, 5));
        }
      } };
    const original = await w.schedule('make:E-original');
    const other = await racer;
    const done = [original, other].filter(r => r.status === 200 && !r.json.existing);
    assert.equal(done.length, 1, `${variant}#${i}: ${JSON.stringify([original.json, other.json])}`);
    assert.ok([original, other].every(r => r.status === 200 || r.json?.error === 'ownership_lost'), `${variant}#${i}`);
    expectDone(await w.consistent(), `E ${variant}#${i}`);
    const key = `${variant}: ${done[0] === original ? 'original owner' : 'takeover'} completed`;
    tally[key] = (tally[key] || 0) + 1;
    await w.mf.dispose();
  }
}
log('E  takeover racing the commit, 10 runs: exactly one owner completed each time; D1 consistent;', JSON.stringify(tally));
// H (C7) ────────────────────────────────────────────────────────────────────
// Retries (Cron ticks and scheduled admin calls) racing collector uploads on real D1.
for (let i = 0; i < 3; i++) {
  const w = await world({ partial: true });
  const first = await w.schedule('cron:H', '2026-09-21T08:30:00Z');
  assert.deepEqual([first.status, first.json.state], [200, 'waiting_for_sources'], JSON.stringify(first.json));
  const burst = [];
  for (let k = 0; k < 6; k++) burst.push(w.tick('2026-09-21T08:45:00Z'));
  for (let k = 0; k < 4; k++) burst.push(w.schedule(`cron:H${k}`, '2026-09-21T08:45:00Z'));
  burst.push(w.updates());
  burst.push(w.report());
  await Promise.all(burst);
  for (let k = 0; k < 3; k++) await Promise.all([w.tick('2026-09-21T09:00:00Z'), w.tick('2026-09-21T09:00:00Z'), w.schedule('cron:Hx', '2026-09-21T09:00:00Z')]);
  // The report may be computed on while its acceptance is still in flight (pending_review satisfies arrival),
  // so the one draft is validated or gate-blocked; either way there is exactly one of everything.
  const c = await w.consistent();
  assert.deepEqual([c.cycles, c.runs, c.snapshots, c.orphans, c.dupSeq, c.contiguous, c.stuck], [1, 1, 1, 0, 0, true, 0], `H#${i}: ${JSON.stringify(c)}`);
  assert.ok(['validated', 'blocked'].includes(c.state), `H#${i}: ${c.state}`);
  assert.equal((await w.q('SELECT COUNT(*) AS n FROM automation_lease'))[0].n, 0);
  const tr = (await w.q("SELECT to_state FROM run_transition ORDER BY seq")).map(t => t.to_state);
  assert.deepEqual(tr.slice(0, 3), ['created', 'waiting_for_sources', 'computing']);
  await w.mf.dispose();
}
log('H  ticks, scheduled calls and uploads in parallel (3 runs): one cycle, one run, one snapshot; waiting → computing → draft; leases released');
// I (C7): an upload lands while the owner is inside the final transaction window
{
  const w = await world({ partial: true });
  await w.schedule('cron:I', '2026-09-21T08:30:00Z');
  await w.updates();
  let inner = null;
  w.ctx.on = async point => { if (point !== 'schedule:before_final_txn' || inner) return;
    inner = Promise.all([w.report(), w.tick('2026-09-21T09:00:00Z'), w.schedule('cron:I-racer', '2026-09-21T09:00:00Z')]);
    await inner; };
  await w.report();                                      // makes the week ready
  const r = await w.schedule('cron:I-owner', '2026-09-21T08:45:00Z');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  expectDone(await w.consistent(), 'I');
  log('I  report re-sent + tick + scheduled call while the owner commits: owner completed; racers saw it in progress; one snapshot');
  await w.mf.dispose();
}
// J (C7): source_timeout on real D1, then a late valid upload resumes the same run
{
  const w = await world({ partial: true });
  const t = await w.schedule('cron:J', '2026-09-22T08:30:00Z');
  assert.equal(t.json.state, 'source_timeout');
  const runId = t.json.runId;
  assert.equal((await w.q('SELECT COUNT(*) AS n FROM snapshot'))[0].n, 0);
  await w.updates(); await w.report();
  await w.tick('2026-09-23T03:00:00Z');
  expectDone(await w.consistent(), 'J');
  assert.equal((await w.q("SELECT run_id FROM reporting_run WHERE trigger = 'schedule'"))[0].run_id, runId);
  log('J  source_timeout on real D1; a later upload resumed the SAME run through the cron tick into one validated draft');
  await w.mf.dispose();
}
console.log('WORKERD ADVERSARIAL: PASS');
