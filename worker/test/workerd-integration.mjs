/**
 * Opt-in integration test: the bundled Worker in Cloudflare's workerd runtime
 * (via Miniflare) against a real local D1, running every migration.
 *
 *   cd worker && npm install && npm run integration
 *
 * Synthetic data only. Secrets are generated per run.
 */
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { hashPassword } = await import(REPO + '/worker/src/auth.js');
const { gqlOrder, ssCustom } = await import(REPO + '/tests/fixtures-normalized.mjs');
const { buildSnapshot } = await import(REPO + '/shared/snapshot.js');
const { normalizeShopifyOrders } = await import(REPO + '/shared/adapters/shopifyGraphql.js');
const { normalizeShipStationRows } = await import(REPO + '/shared/adapters/shipstation.js');
const rnd = () => crypto.randomUUID() + crypto.randomUUID();
const PASSWORD = 'synthetic-' + crypto.randomUUID();
const S = { INGEST_SECRET: rnd(), ADMIN_SECRET: rnd(), SESSION_SIGNING_KEY: rnd(), DASHBOARD_PASSWORD_HASH: await hashPassword(PASSWORD, { iterations: 100000 }) };
const bundle = await build({ entryPoints: [path.join(REPO, 'worker/src/index.js')], bundle: true, format: 'esm',
  platform: 'neutral', target: 'es2022', write: false });
const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2024-09-01', d1Databases: ['DB'],
  bindings: { ...S, ALLOWED_ORIGINS: 'https://sb-profit.netlify.app', COOKIE_SAMESITE: 'Strict', PUBLICATION_ALLOWED: 'false', D1_QUOTA_BYTES: '5000000000' } });
const db = await mf.getD1Database('DB');
for (const f of fs.readdirSync(REPO + '/worker/migrations').sort()) {
  const sql = fs.readFileSync(path.join(REPO, 'worker/migrations', f), 'utf8').split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  const stmts = sql.split(/;\s*\n/).map(s => s.trim()).filter(Boolean);
  await db.batch(stmts.map(s => db.prepare(s)));
}
const call = async (method, p, { body, headers = {} } = {}) => {
  const r = await mf.dispatchFetch('https://w.example' + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, headers: r.headers, json: j };
};
const I = { 'X-Ingest-Secret': S.INGEST_SECRET }, A = { 'X-Admin-Secret': S.ADMIN_SECRET };
// catalog
const v = (n, c) => Object.fromEntries(Array.from({ length: c }, (_, i) => [`${n}-${i}`, { unitCost: 1 }]));
const catalog = { tables: { mcg_total: { P: 1 }, product_costs: {}, sku_weights: {}, sb_costs: {}, hp_supplement: { 'MG-ALOE': 4.5 }, hp_by_name: {}, sku_alias: {},
  vendor_costs: { 'Live to Give': v('L', 30), 'Lively Good': v('G', 171), 'Calathea Collective': v('C', 462), 'Surfside Arrangement': v('S', 11), 'LindaMakes': v('M', 396) },
  vendor_index: { x: {} } } };
const c = await call('POST', '/v1/ingest/catalog', { body: catalog, headers: I }); assert.equal(c.json.accepted, true, JSON.stringify(c.json));
// 400 orders → exercises json_each chunking + batch sizes in real D1
const nodes = [], ship = [];
for (let i = 0; i < 400; i++) {
  const name = `#7${String(i).padStart(5, '0')}`;
  const lines = [{ sku: 'MG-ALOE', price: 10, qty: 2, vendor: 'Succulents Box', allocations: i % 3 ? [] : [{ amount: 2 }] }];
  if (i % 4 === 0) lines.push({ sku: 'ROUTEINS', name: 'Shipping Protection by Route - 0.98', price: 0.98, vendor: 'Route' });
  if (i % 9 === 0) lines.push({ sku: 'NOPE-1', price: 5, vendor: 'Nobody' });
  const sub = lines.reduce((s, l) => s + l.price * (l.qty || 1), 0) - (i % 3 ? 0 : 2);
  const refunds = i % 50 === 0 ? [{ amount: 5, lines: [{ lineIndex: 0, subtotal: 5 }] }] : [];
  nodes.push(gqlOrder({ name, createdAt: `2026-09-${15 + (i % 5)}T18:00:00Z`, subtotal: sub, shipping: 5, total: sub + 5, discounts: i % 3 ? 0 : 2, refunded: refunds.length ? 5 : 0, lines, refunds }));
  ship.push(...ssCustom({ shipment: `Z${i}`, order: name.slice(1), fee: i % 25 === 0 ? '0' : '5.10', rate: i % 25 === 0 ? '0' : '5.40' }));
}
const t0 = Date.now();
const o = await call('POST', '/v1/ingest/shopify', { body: { format: 'graphql', nodes, weekStart: '2026-09-14' }, headers: I });
assert.equal(o.status, 200, JSON.stringify(o.json)); assert.equal(o.json.rowsWritten, 400);
const s = await call('POST', '/v1/ingest/shipstation', { body: { format: 'rows', rows: ship, weekStart: '2026-09-14' }, headers: I });
assert.equal(s.json.rowsWritten, 400);
const again = await call('POST', '/v1/ingest/shopify', { body: { format: 'graphql', nodes, weekStart: '2026-09-14' }, headers: I });
assert.deepEqual([again.json.rowsWritten, again.json.duplicates], [0, 400]);
const run = await call('POST', '/v1/admin/runs', { body: { weekStart: '2026-09-14' }, headers: A });
assert.equal(run.status, 200, JSON.stringify(run.json));
console.log('run:', run.json.state, run.json.snapshotStatus, run.json.profitabilityStatus, 'gate failures:', run.json.gate.failures.map(f => f.code).join(',') || 'none', `(${Date.now() - t0} ms)`);
const snap = await call('GET', '/v1/snapshot/2026-09-14?includeDrafts=1', { headers: A });
const direct = buildSnapshot({ weekStart: '2026-09-14', orders: normalizeShopifyOrders(nodes), shipments: normalizeShipStationRows(ship).shipments, catalog: { rev: 'x', ...catalog } });
for (const k of Object.keys(direct.totals).filter(k => k !== 'labels')) assert.deepEqual(snap.json.totals[k], direct.totals[k], k);
console.log('D1 round-trip totals identical to direct build:', Object.keys(direct.totals).length - 1, 'fields');
console.log('  operating revenue', snap.json.totals.operatingRevenue, ' route', JSON.stringify(snap.json.passThrough), ' coverage', snap.json.totals.shipStationExpenseCoverage + '%');
const page = await call('GET', '/v1/snapshot/2026-09-14/orders?includeDrafts=1&limit=50&offset=350', { headers: A });
assert.deepEqual([page.json.orders.length, page.json.page.total], [50, 400]);
const pub = await call('POST', '/v1/admin/publish', { body: { snapshotId: run.json.snapshotId }, headers: A });
console.log('publish while locked:', pub.status, pub.json.error, pub.json.detail?.reason);
const login = await call('POST', '/v1/auth/login', { body: { password: PASSWORD }, headers: { 'CF-Connecting-IP': '198.51.100.1' } });
const cookie = login.headers.get('Set-Cookie');
console.log('login:', login.status, cookie.replace(/=[^;]+/, '=<token>'));
const weeks = await call('GET', '/v1/weeks', { headers: { Cookie: cookie.split(';')[0] } });
console.log('session sees published weeks:', JSON.stringify(weeks.json.weeks));
const st = await call('GET', '/v1/admin/storage', { headers: A });
console.log('storage:', st.json.bytesUsed, 'bytes,', st.json.pctOfQuota + '%');

// ── Real-D1 semantics the publish transaction relies on ──
// 1. A failing guard statement aborts the WHOLE batch and its message is recognisable.
const before = (await db.prepare("SELECT value FROM settings WHERE key = 'ss_coverage_threshold'").first()).value;
let guardMsg = null;
try {
  await db.batch([db.prepare("UPDATE settings SET value = '0.5' WHERE key = 'ss_coverage_threshold'"),
                  db.prepare('INSERT INTO write_guard (ok) SELECT NULL WHERE NOT (0)')]);
} catch (e) { guardMsg = String(e.message); }
assert.match(guardMsg || '', /NOT NULL constraint failed: write_guard/);
assert.equal((await db.prepare("SELECT value FROM settings WHERE key = 'ss_coverage_threshold'").first()).value, before, 'batch rolled back');
console.log('guard abort rolls back the batch in real D1:', guardMsg.slice(0, 60));
await mf.dispose();

// 2. The full go-live path on real D1 in a throwaway instance with both locks ON
//    (only here; the repository keeps them off).
const mf2 = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2024-09-01', d1Databases: ['DB'],
  bindings: { ...S, ALLOWED_ORIGINS: 'https://sb-profit.netlify.app', COOKIE_SAMESITE: 'Strict', PUBLICATION_ALLOWED: 'true', D1_QUOTA_BYTES: '5000000000' } });
const db2 = await mf2.getD1Database('DB');
for (const f of fs.readdirSync(REPO + '/worker/migrations').sort()) {
  const sql = fs.readFileSync(path.join(REPO, 'worker/migrations', f), 'utf8').split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  await db2.batch(sql.split(/;\s*\n/).map(x => x.trim()).filter(Boolean).map(x => db2.prepare(x)));
}
const call2 = async (method, p, { body, headers = {} } = {}) => {
  const r = await mf2.dispatchFetch('https://w.example' + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j };
};
await call2('POST', '/v1/admin/settings', { body: { carrier_fee_priority_locked: true, publication_enabled: true, reason: 'integration test only' }, headers: A });
const rf = (await call2('POST', '/v1/admin/catalog-refresh', { body: { weekStart: '2026-09-14' }, headers: A })).json.refreshId;
assert.equal((await call2('POST', '/v1/ingest/catalog', { body: { ...catalog, meta: { refreshId: rf } }, headers: I })).json.refresh.status, 'fulfilled');
const few = nodes.slice(0, 40), fewShip = ship.filter(r => few.some(n => n.name.slice(1) === r['Order Number']));
await call2('POST', '/v1/ingest/shopify', { body: { format: 'graphql', nodes: few, weekStart: '2026-09-14' }, headers: I });
await call2('POST', '/v1/ingest/shipstation', { body: { format: 'rows', rows: fewShip.map(r => ({ ...r, 'Carrier Fee': '5.10' })), weekStart: '2026-09-14' }, headers: I });
const run2 = await call2('POST', '/v1/admin/runs', { body: { weekStart: '2026-09-14' }, headers: A });
assert.equal(run2.json.state, 'validated', JSON.stringify(run2.json.gate?.failures));
const [p1, p2] = await Promise.all([call2('POST', '/v1/admin/publish', { body: { snapshotId: run2.json.snapshotId }, headers: A }),
                                    call2('POST', '/v1/admin/publish', { body: { snapshotId: run2.json.snapshotId }, headers: A })]);
assert.deepEqual([p1.status, p2.status], [200, 200]);
const states = await db2.prepare("SELECT (SELECT status FROM snapshot WHERE snapshot_id = ?1) AS s, (SELECT state FROM reporting_run WHERE run_id = ?2) AS r, (SELECT COUNT(*) FROM run_transition WHERE run_id = ?2 AND to_state = 'published') AS n")
  .bind(run2.json.snapshotId, run2.json.runId).first();
assert.deepEqual([states.s, states.r, states.n], ['published', 'published', 1]);
console.log('atomic publish on real D1: snapshot', states.s, '/ run', states.r, '/ published transitions', states.n, '/ concurrent retry', p1.json.alreadyPublished || p2.json.alreadyPublished ? 'idempotent' : 'n/a');
await mf2.dispose();

// 3. Scheduled-week ownership on real D1: two simultaneous scheduled computes.
const mf3 = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2024-09-01', d1Databases: ['DB'],
  bindings: { ...S, ALLOWED_ORIGINS: 'https://sb-profit.netlify.app', COOKIE_SAMESITE: 'Strict', PUBLICATION_ALLOWED: 'false', D1_QUOTA_BYTES: '5000000000' } });
const db3 = await mf3.getD1Database('DB');
for (const f of fs.readdirSync(REPO + '/worker/migrations').sort()) {
  const sql = fs.readFileSync(path.join(REPO, 'worker/migrations', f), 'utf8').split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  await db3.batch(sql.split(/;\s*\n/).map(x => x.trim()).filter(Boolean).map(x => db3.prepare(x)));
}
const call3 = async (method, p, { body, headers = {} } = {}) => {
  const r = await mf3.dispatchFetch('https://w.example' + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j };
};
const W = '2026-09-14';
const rf3 = (await call3('POST', '/v1/admin/catalog-refresh', { body: { weekStart: W }, headers: A })).json.refreshId;
await call3('POST', '/v1/ingest/catalog', { body: { ...catalog, meta: { refreshId: rf3 } }, headers: I });
await call3('POST', '/v1/ingest/shopify', { body: { format: 'graphql', mode: 'week', nodes: few, weekStart: W }, headers: I });
await call3('POST', '/v1/ingest/shopify', { body: { format: 'graphql', mode: 'updated_since', nodes: [], weekStart: W }, headers: I });
await call3('POST', '/v1/ingest/shipstation', { body: { format: 'rows', rows: fewShip, weekStart: W }, headers: I });
const sched = label => call3('POST', '/v1/admin/runs', { body: { weekStart: W, trigger: 'schedule', actorLabel: label }, headers: A });
const counts = async () => db3.prepare(`SELECT (SELECT COUNT(*) FROM schedule_cycle) AS cycles,
    (SELECT COUNT(*) FROM reporting_run WHERE trigger = 'schedule') AS runs, (SELECT COUNT(*) FROM snapshot) AS snaps,
    (SELECT COUNT(*) FROM reporting_run WHERE state IN ('created','computing')) AS stuck`).first();
const [s1, s2] = await Promise.all([sched('make:S4a'), sched('make:S4b')]);
assert.deepEqual([s1.status, s2.status], [200, 200], JSON.stringify([s1.json, s2.json]));
assert.equal(s1.json.runId, s2.json.runId);
assert.ok(s1.json.existing || s2.json.existing, 'one request must report existing=true');
let c3 = await counts();
assert.deepEqual([c3.cycles, c3.runs, c3.snaps, c3.stuck], [1, 1, 1, 0]);
console.log('simultaneous scheduled computes on real D1: cycles', c3.cycles, '/ scheduled runs', c3.runs, '/ snapshots', c3.snaps,
            '/ stuck', c3.stuck, '/ same run', s1.json.runId === s2.json.runId, '/ existing', [s1.json.existing, s2.json.existing].join(','));
// Interrupted claim (request died while computing) and failed claim: both resume the SAME run.
for (const state of ['computing', 'failed']) {
  await db3.batch([db3.prepare('DELETE FROM snapshot'),
    db3.prepare("UPDATE reporting_run SET state = ?1, snapshot_id = NULL, updated_at = '2026-01-01T00:00:00.000Z' WHERE trigger = 'schedule'").bind(state)]);
  const [x, y] = await Promise.all([sched('make:retry1'), sched('make:retry2')]);
  assert.deepEqual([x.status, y.status], [200, 200], JSON.stringify([x.json, y.json]));
  assert.equal(x.json.runId, s1.json.runId); assert.equal(y.json.runId, s1.json.runId);
  assert.equal([x.json, y.json].filter(r => r.resumed).length, 1, 'exactly one request resumes');
  c3 = await counts();
  assert.deepEqual([c3.cycles, c3.runs, c3.snaps, c3.stuck], [1, 1, 1, 0], state);
  console.log(`resume after ${state} claim on real D1: same run, resumed once, snapshots ${c3.snaps}, stuck ${c3.stuck}`);
}
const cyc = await db3.prepare('SELECT attempts FROM schedule_cycle').first();
assert.equal(cyc.attempts, 3);
await mf3.dispose();
console.log('WORKERD INTEGRATION: PASS');
