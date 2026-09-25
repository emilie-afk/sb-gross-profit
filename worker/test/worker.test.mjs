/**
 * Worker tests against the real migrations on a local SQLite D1 stand-in.
 * Secrets and the password hash are generated per run; nothing secret-shaped
 * is committed. All orders, SKUs and amounts are synthetic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/index.js';
import { hashPassword, verifyPassword, timingSafeEqual } from '../src/auth.js';
import { planBackfill } from '../src/admin.js';
import { canTransition, TRANSITIONS } from '../src/runs.js';
import { buildSnapshot } from '../../shared/snapshot.js';
import { normalizeShopifyOrders } from '../../shared/adapters/shopifyGraphql.js';
import { normalizeShipStationRows } from '../../shared/adapters/shipstation.js';
import { gqlOrder, ssCustom } from '../../tests/fixtures-normalized.mjs';

import { PASSWORD, WEEK, makeEnv, bodies, call, ingest, admin, sessionCookie, catalog, weekOrders, loaded, viaNormalized, ingestReport } from './helpers.mjs';

// ─── Auth and credential classes ──────────────────────────────────────────────

test('password hashes verify, reject wrong passwords, and compare in constant time', async () => {
  const h = await hashPassword('abc', { iterations: 1000 });
  assert.match(h, /^pbkdf2_sha256\$1000\$/);
  assert.equal(await verifyPassword('abc', h), true);
  assert.equal(await verifyPassword('abd', h), false);
  assert.equal(await verifyPassword('abc', 'plaintext'), false);
  assert.equal(timingSafeEqual('same', 'same'), true);
  assert.equal(timingSafeEqual('same', 'samf'), false);
  assert.equal(timingSafeEqual('short', 'longer'), false);
});

test('A17: reads without a session are refused', async () => {
  const env = await makeEnv();
  for (const p of ['/v1/weeks', `/v1/snapshot/${WEEK}`, `/v1/snapshot/${WEEK}/orders`, '/v1/history', `/v1/compare?from=${WEEK}&to=${WEEK}`]) {
    const r = await call(env, 'GET', p);
    assert.equal(r.status, 401, p);
    assert.equal(r.json.error, 'session_expired');
  }
});

test('A18/A19: ingest and admin secrets are not interchangeable', async () => {
  const env = await makeEnv();
  const a = await call(env, 'POST', '/v1/ingest/shopify', { body: viaNormalized({ nodes: [] }), headers: { 'X-Ingest-Secret': env.ADMIN_SECRET } });
  assert.equal(a.status, 401); assert.equal(a.json.error, 'ingest_auth');
  const b = await call(env, 'GET', '/v1/admin/settings', { headers: { 'X-Admin-Secret': env.INGEST_SECRET } });
  assert.equal(b.status, 401); assert.equal(b.json.error, 'admin_auth');
});

test('a Worker configured with identical secrets refuses to serve', async () => {
  const env = await makeEnv();
  env.ADMIN_SECRET = env.INGEST_SECRET;
  const r = await call(env, 'GET', '/v1/admin/settings', { headers: { 'X-Admin-Secret': env.ADMIN_SECRET } });
  assert.equal(r.status, 500); assert.equal(r.json.error, 'misconfigured');
});

test('login issues a Strict, HttpOnly, Secure session; A23: logout revokes it', async () => {
  const env = await makeEnv();
  const bad = await call(env, 'POST', '/v1/auth/login', { body: { password: 'wrong' } });
  assert.equal(bad.status, 401);
  const ok = await call(env, 'POST', '/v1/auth/login', { body: { password: PASSWORD } });
  const set = ok.headers.get('Set-Cookie');
  for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=43200']) assert.ok(set.includes(attr), attr);
  const cookie = set.split(';')[0];
  assert.equal((await call(env, 'GET', '/v1/auth/session', { cookie })).status, 200);
  assert.equal((await call(env, 'POST', '/v1/auth/logout', { cookie })).status, 200);
  assert.equal((await call(env, 'GET', '/v1/auth/session', { cookie })).status, 401);
  assert.equal((await call(env, 'GET', '/v1/weeks', { cookie })).status, 401);
});

test('a tampered or forged session token is rejected', async () => {
  const env = await makeEnv();
  const cookie = await sessionCookie(env);
  const [name, token] = cookie.split('=');
  const [body, sig] = token.split('.');
  const tampered = `${name}=${body}x.${sig}`;
  assert.equal((await call(env, 'GET', '/v1/auth/session', { cookie: tampered })).status, 401);
  const other = await makeEnv();
  assert.equal((await call(other, 'GET', '/v1/auth/session', { cookie })).status, 401);
});

test('A20: the 11th failed login inside 15 minutes is rate limited', async () => {
  const env = await makeEnv();
  for (let i = 0; i < 10; i++) assert.equal((await call(env, 'POST', '/v1/auth/login', { body: { password: 'nope' } })).status, 401);
  const r = await call(env, 'POST', '/v1/auth/login', { body: { password: PASSWORD } });
  assert.equal(r.status, 429); assert.equal(r.json.error, 'rate_limited');
  const stored = await env.DB.prepare('SELECT DISTINCT ip_hash FROM auth_attempt').all();
  assert.ok(stored.results.every(x => !x.ip_hash.includes('203.0.113.7')));   // only a keyed hash is stored
});

test('A21: CORS answers only exact allowlisted origins', async () => {
  const env = await makeEnv();
  const listed = await call(env, 'GET', '/v1/health', { headers: { Origin: 'https://sb-profit.netlify.app' } });
  assert.equal(listed.headers.get('Access-Control-Allow-Origin'), 'https://sb-profit.netlify.app');
  assert.equal(listed.headers.get('Access-Control-Allow-Credentials'), 'true');
  const other = await call(env, 'GET', '/v1/health', { headers: { Origin: 'https://evil.example' } });
  assert.equal(other.headers.get('Access-Control-Allow-Origin'), null);
  const pre = await worker.fetch(new Request('https://worker.example/v1/weeks', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), env);
  assert.equal(pre.status, 403);
});

// ─── Ingestion ────────────────────────────────────────────────────────────────

test('A6: re-posting an identical batch writes nothing and creates no duplicates', async () => {
  const { env, nodes, ship } = await loaded(10);
  const again = await ingest(env, '/v1/ingest/shopify', viaNormalized({ nodes, weekStart: WEEK }));
  assert.deepEqual([again.json.rowsWritten, again.json.duplicates], [0, 10]);
  const s2 = await ingest(env, '/v1/ingest/shipstation', { format: 'rows', rows: ship, weekStart: WEEK });
  assert.deepEqual([s2.json.rowsWritten, s2.json.duplicates], [0, 10]);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM shopify_order').first()).n, 10);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM shipment').first()).n, 10);
});

test('a changed order is rewritten in place, children replaced, not duplicated', async () => {
  const { env, nodes } = await loaded(3);
  nodes[0].lineItems.nodes.push({ id: 'gid://x/LineItem/extra', sku: 'MG-JADE', name: 'MG-JADE', quantity: 1, currentQuantity: 1,
    requiresShipping: true, vendor: 'Succulents Box', originalUnitPriceSet: { shopMoney: { amount: '6' } }, discountAllocations: [] });
  const r = await ingest(env, '/v1/ingest/shopify', viaNormalized({ nodes, weekStart: WEEK }));
  assert.deepEqual([r.json.rowsWritten, r.json.duplicates], [1, 2]);
  const lines = await env.DB.prepare('SELECT COUNT(*) AS n FROM shopify_order_line WHERE order_name = ?1').bind(nodes[0].name).first();
  assert.equal(lines.n, nodes[0].lineItems.nodes.length);
});

test('A11 at the API: customer fields are rejected and the run is recorded as failed', async () => {
  const env = await makeEnv();
  const [bad] = normalizeShopifyOrders([gqlOrder({ subtotal: 10, total: 10, lines: [{ sku: 'MG-ALOE', price: 10 }] })], { timeZone: 'America/Los_Angeles' });
  bad.email = 'synthetic@example.invalid';
  const r = await ingest(env, '/v1/ingest/shopify', { format: 'normalized', storeTimezone: 'America/Los_Angeles', orders: [bad] });
  assert.equal(r.status, 400); assert.equal(r.json.error, 'customer_data_rejected');
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM shopify_order').first()).n, 0);
  assert.equal((await env.DB.prepare("SELECT status FROM ingest_run WHERE source = 'shopify'").first()).status, 'failed');
});

test('there is no Shopify API route: format graphql is refused before any run starts', async () => {
  const env = await makeEnv();
  const r = await ingest(env, '/v1/ingest/shopify', { format: 'graphql', nodes: [] });
  assert.deepEqual([r.status, r.json.error], [400, 'format_unavailable']);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM ingest_run').first()).n, 0);
});

test('ShipStation ingest reports level-1 diagnostics with header names only', async () => {
  const env = await makeEnv();
  const r = await ingest(env, '/v1/ingest/shipstation', { format: 'rows', rows: ssCustom({ fee: '0', rate: '0' }) });
  assert.equal(r.json.diagnostics.level, 'raw_import');
  assert.equal(r.json.diagnostics.shipmentsWithoutPositiveCost, 1);
  assert.ok(r.json.diagnostics.ignoredColumns.includes('Recipient'));
  const stored = JSON.stringify((await env.DB.prepare('SELECT * FROM shipment').all()).results);
  assert.ok(!stored.includes('SYNTHETIC RECIPIENT'));
});

test('HPD ingest keeps the Shopify order number and drops buyer notes', async () => {
  const env = await makeEnv();
  const text = ['Date - Order Date,Order - Number,Carrier - Service Selected,Ship To - State,Item - Qty,Item - SKU,Notes - From Buyer,Actual Net Terms Cost (Labor + Carrier Shipping),Prepaid Fixed Price,Cost Difference (Net Terms - Prepaid)',
    '2026-09-15,HPD-1,USPS,ZZ,1,FH-POTHOS,"#900001 synthetic note",7.10,6.00,1.10'].join('\n');
  const r = await ingest(env, '/v1/ingest/hpd', { format: 'csv_text', text });
  assert.equal(r.status, 200);
  const row = await env.DB.prepare('SELECT * FROM hpd_order').first();
  assert.deepEqual([row.shopify_order_number, row.net_terms], ['900001', 7.1]);
  assert.ok(!JSON.stringify(row).includes('synthetic note'));
});

test('A36/A37 at the API: a shrunken catalog is rejected and the previous one stays active', async () => {
  const env = await makeEnv();
  const good = await ingest(env, '/v1/ingest/catalog', catalog());
  assert.equal(good.json.accepted, true);
  const small = await ingest(env, '/v1/ingest/catalog', catalog({ calathea: 300 }));
  assert.equal(small.json.accepted, false);
  assert.equal(small.json.activeCatalogRev, good.json.catalogRev);
  const empty = await ingest(env, '/v1/ingest/catalog', { tables: {} });
  assert.equal(empty.json.accepted, false);
  const again = await ingest(env, '/v1/ingest/catalog', catalog());
  assert.deepEqual([again.json.catalogRev, again.json.duplicates], [good.json.catalogRev, 1]);
  const accepted = await env.DB.prepare("SELECT COUNT(*) AS n FROM cost_catalog WHERE status = 'accepted'").first();
  assert.equal(accepted.n, 1);
});

// ─── Compute, gate, publication ───────────────────────────────────────────────

test('compute writes a snapshot from D1 identical to one built directly from the payload', async () => {
  const { env, nodes, ship } = await loaded(40);
  const r = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const cat = catalog();
  // C3: the Worker's expense source is the Shipping Cost Report (loaded() ingests one row per order).
  const report = new Map(nodes.map((o, i) => [o.name.slice(1), { orderKey: o.name.slice(1), costCents: i % 20 === 0 ? 540 : 510, rowCount: 1,
    firstShipDate: `2026-09-${15 + (i % 5)}`, lastShipDate: `2026-09-${15 + (i % 5)}` }]));
  const direct = buildSnapshot({ weekStart: WEEK, orders: normalizeShopifyOrders(nodes),
    shipments: normalizeShipStationRows(ship).shipments, catalog: { rev: 'x', ...cat },
    shippingSource: 'shipping_cost_report', shippingCostReport: report });
  const stored = await admin(env, 'GET', `/v1/snapshot/${WEEK}?includeDrafts=1`);
  assert.equal(stored.status, 200);
  for (const k of ['operatingRevenue', 'shopifyNetRevenueInclPassThrough', 'operatingGpAfterShipping', 'routeCollected', 'routeNet',
                   'knownProductCogs', 'knownCostProductGp', 'missingCostRevenue', 'missingCostLines', 'shippingExpense',
                   'ordersRequiringShipStationRate', 'ordersWithValidShipStationRate', 'profitabilityStatus']) {
    assert.deepEqual(stored.json.totals[k], direct.totals[k], k);
  }
  assert.ok(stored.json.reconciliation.every(c => c.passed || !c.blocking));
  assert.match(stored.json.narrative.headline, /^Provisional operating GP after shipping/);
});

test('the gate blocks a week under the coverage threshold, and a blocked draft cannot publish', async () => {
  const { env } = await loaded(20, {}, { reportMissingEvery: 20 });   // 1 of 20 orders without a report row → 95%
  await admin(env, 'POST', '/v1/admin/settings', { ss_coverage_threshold: 0.99, reason: 'test threshold' });
  const r = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  assert.equal(r.json.state, 'blocked');
  assert.ok(r.json.gate.failures.some(f => f.code === 'ss_coverage'));
  const p = await admin(env, 'POST', '/v1/admin/publish', { snapshotId: r.json.snapshotId });
  assert.equal(p.status, 409);
});

test('publication is refused while the go-live switch is off, even for a validated draft', async () => {
  const { env } = await loaded(20);
  const r = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  assert.equal(r.json.state, 'validated', JSON.stringify(r.json.gate.failures));
  const p = await admin(env, 'POST', '/v1/admin/publish', { snapshotId: r.json.snapshotId });
  assert.deepEqual([p.status, p.json.detail.reason], [409, 'publication_disabled']);
  await admin(env, 'POST', '/v1/admin/settings', { publication_enabled: true, reason: 'test go-live' });
  const p2 = await admin(env, 'POST', '/v1/admin/publish', { snapshotId: r.json.snapshotId });
  assert.deepEqual([p2.status, p2.json.detail.reason], [409, 'publication_not_allowed_in_environment']);
  const cookie = await sessionCookie(env);
  assert.equal((await call(env, 'GET', `/v1/snapshot/${WEEK}`, { cookie })).json.error, 'not_published');
  assert.deepEqual((await call(env, 'GET', '/v1/weeks', { cookie })).json.weeks, []);
});

test('A15/A16: publishing a revision supersedes the previous one; published numbers never change', async () => {
  const { env } = await loaded(20, { PUBLICATION_ALLOWED: 'true' });
  await admin(env, 'POST', '/v1/admin/settings', { publication_enabled: true, reason: 'test go-live' });
  const r1 = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  assert.equal((await admin(env, 'POST', '/v1/admin/publish', { snapshotId: r1.json.snapshotId })).status, 200);
  const cookie = await sessionCookie(env);
  const before = (await call(env, 'GET', `/v1/snapshot/${WEEK}`, { cookie })).json;
  assert.equal(before.revision, 1);

  const cheaper = catalog(); cheaper.tables.hp_supplement['MG-ALOE'] = 4.0;           // cost correction → new catalog rev
  assert.equal((await ingest(env, '/v1/ingest/catalog', cheaper)).json.accepted, true);
  assert.equal((await admin(env, 'POST', '/v1/admin/restate-costs', { weekStart: WEEK })).status, 400);   // reason required
  const r2 = await admin(env, 'POST', '/v1/admin/restate-costs', { weekStart: WEEK, reason: 'MG-ALOE cost corrected by vendor' });
  assert.equal(r2.status, 200, JSON.stringify(r2.json));
  assert.equal(r2.json.revision, 2);
  assert.equal((await call(env, 'GET', `/v1/snapshot/${WEEK}`, { cookie })).json.revision, 1);       // draft not visible
  assert.equal((await admin(env, 'POST', '/v1/admin/publish', { snapshotId: r2.json.snapshotId })).status, 200);
  const after = (await call(env, 'GET', `/v1/snapshot/${WEEK}`, { cookie })).json;
  assert.equal(after.revision, 2);
  assert.ok(after.totals.knownProductCogs < before.totals.knownProductCogs);
  const r1Row = await env.DB.prepare('SELECT s.status, t.known_product_cogs FROM snapshot s JOIN snapshot_totals t USING (snapshot_id) WHERE s.revision = 1').first();
  assert.deepEqual([r1Row.status, r1Row.known_product_cogs], ['superseded', before.totals.knownProductCogs]);
  const old = (await call(env, 'GET', `/v1/snapshot/${WEEK}?revision=1`, { cookie }));
  assert.equal(old.status, 404);                                                                   // sessions see published only
});

test('A25: orders are paginated and filterable; order detail and issues are per-snapshot', async () => {
  const { env } = await loaded(120, {}, { reportMissingEvery: 20 });
  await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  const p1 = await admin(env, 'GET', `/v1/snapshot/${WEEK}/orders?includeDrafts=1&limit=50&offset=0&sort=gp_asc`);
  assert.deepEqual([p1.json.orders.length, p1.json.page.total], [50, 120]);
  const p3 = await admin(env, 'GET', `/v1/snapshot/${WEEK}/orders?includeDrafts=1&limit=50&offset=100`);
  assert.equal(p3.json.orders.length, 20);
  const gps = p1.json.orders.map(o => o.operatingGp);
  assert.deepEqual(gps, [...gps].sort((a, b) => a - b));
  const miss = await admin(env, 'GET', `/v1/snapshot/${WEEK}/orders?includeDrafts=1&missingShipping=true`);
  assert.equal(miss.json.page.total, 6);                                                           // every 20th has no report row
  const bad = await admin(env, 'GET', `/v1/snapshot/${WEEK}/orders?includeDrafts=1&limit=5000`);
  assert.equal(bad.status, 400);
  const one = await admin(env, 'GET', `/v1/snapshot/${WEEK}/orders/${encodeURIComponent('#900005')}?includeDrafts=1`);
  assert.equal(one.status, 200);
  assert.ok(one.json.lines.some(l => l.sku === 'ROUTEINS' && l.routeCollected === 0.98 && l.flags.isProductLine === false));
  const issues = await admin(env, 'GET', `/v1/snapshot/${WEEK}/issues?includeDrafts=1&kind=missing_shipping`);
  assert.equal(issues.json.page.total, 6);
});

test('A24/A26: the default snapshot read carries no line rows; scenario input carries only what scenario.js reads', async () => {
  const { env } = await loaded(30);
  await admin(env, 'GET', '/v1/admin/settings');
  await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  const snap = await admin(env, 'GET', `/v1/snapshot/${WEEK}?includeDrafts=1`);
  assert.equal(snap.json.lines, undefined);
  assert.equal(snap.json.orders, undefined);
  assert.ok(JSON.stringify(snap.json).length < 200_000);
  const si = await admin(env, 'GET', `/v1/snapshot/${WEEK}/scenario-input?includeDrafts=1`);
  const keys = new Set(si.json.lines.flatMap(l => Object.keys(l)));
  for (const k of keys) assert.ok(['orderNum', 'date', 'sku', 'product', 'vendor', 'vendorKey', 'qty', 'unitPrice', 'baseMerchRevenue',
    'lineRevenue', 'lineCogs', 'missingCost', 'costSource', 'isRoute', 'isGiftCard', 'isInfluencerSample', 'shipCollected', 'shipPaid'].includes(k), k);
});

test('history and compare use the operating definition and flag provisional comparisons', async () => {
  const { env, nodes, ship } = await loaded(10);
  // C8: every computed week needs an accepted Shipping Cost Report received after
  // it closed, so the second week is the one BEFORE WEEK (its report is in).
  const PREV = '2026-09-07', back = iso => new Date(Date.parse(iso) - 7 * 86400000).toISOString();
  const prev = nodes.map(n => ({ ...n, name: n.name.replace('#9', '#8'), createdAt: back(n.createdAt) }));
  await ingest(env, '/v1/ingest/shopify', viaNormalized({ nodes: prev, weekStart: PREV }));
  await ingest(env, '/v1/ingest/shipstation', { format: 'rows', rows: ship.map(r => ({ ...r, 'Shipment ID': 'N' + r['Shipment ID'], 'Order Number': r['Order Number'].replace(/^9/, '8') })), weekStart: PREV });
  await ingestReport(env, prev.map(o => ({ order: o.name.slice(1), date: o.createdAt.slice(0, 10), cost: 5.1 })),
                     { from: PREV, to: '2026-09-13', exportedAt: '2026-09-14T15:00:00Z' });
  await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  await admin(env, 'POST', '/v1/admin/runs', { weekStart: PREV });
  const h = await admin(env, 'GET', '/v1/history?includeDrafts=1&from=2026-09-01&to=2026-09-30');
  assert.deepEqual(h.json.weeks.map(w => w.weekStart), [PREV, WEEK]);
  assert.equal(h.json.definition, 'operating');
  const c = await admin(env, 'GET', `/v1/compare?includeDrafts=1&from=${PREV}&to=${WEEK}`);
  assert.equal(c.status, 200);
  assert.equal(c.json.provisional, true);
  assert.equal(typeof c.json.delta.operatingRevenue, 'number');
});

// ─── Runs, backfill, go-live checks, storage ──────────────────────────────────

test('the run state machine only allows the documented transitions', () => {
  assert.equal(canTransition('created', 'computing'), true);
  assert.equal(canTransition('draft', 'published'), false);        // must be validated first
  assert.equal(canTransition('blocked', 'published'), false);
  assert.deepEqual(TRANSITIONS.published, []);                     // terminal
  assert.equal(canTransition('failed', 'computing'), true);
});

test('recompute on a published run is refused: corrections are new runs and new revisions', async () => {
  const { env } = await loaded(20, { PUBLICATION_ALLOWED: 'true' });
  await admin(env, 'POST', '/v1/admin/settings', { publication_enabled: true, reason: 'test go-live' });
  const r = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  assert.equal((await admin(env, 'POST', '/v1/admin/publish', { snapshotId: r.json.snapshotId })).status, 200);
  const again = await admin(env, 'POST', `/v1/admin/runs/${r.json.runId}/compute`, {});
  assert.deepEqual([again.status, again.json.error], [409, 'invalid_transition']);
  const detail = await admin(env, 'GET', `/v1/admin/runs/${r.json.runId}`);
  assert.deepEqual(detail.json.transitions.map(t => t.to_state), ['created', 'computing', 'draft', 'validated', 'published']);
});

test('a second publish of the same snapshot changes nothing and the week keeps one published revision', async () => {
  const { env } = await loaded(20, { PUBLICATION_ALLOWED: 'true' });
  await admin(env, 'POST', '/v1/admin/settings', { publication_enabled: true, reason: 'test go-live' });
  const r = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  const [a, b] = await Promise.all([admin(env, 'POST', '/v1/admin/publish', { snapshotId: r.json.snapshotId }),
                                    admin(env, 'POST', '/v1/admin/publish', { snapshotId: r.json.snapshotId })]);
  assert.deepEqual([a.status, b.status], [200, 200]);                            // publishing is idempotent
  assert.equal([a.json, b.json].filter(x => x.alreadyPublished).length, 1);
  const rows = (await env.DB.prepare('SELECT snapshot_id, status, superseded_by FROM snapshot WHERE week_start = ?1').bind(WEEK).all()).results;
  assert.deepEqual(rows.map(x => [x.status, x.superseded_by]), [['published', null]]);
  assert.equal((await admin(env, 'POST', '/v1/admin/revise', { weekStart: WEEK, reason: 'second draft' })).status, 200);
  assert.throws(() => env.DB.db.prepare("UPDATE snapshot SET status = 'published' WHERE revision = 2").run(), /UNIQUE/);   // one published per week
});

test('a draft replaced by a recompute of the same run cannot be published', async () => {
  const { env } = await loaded(20, { PUBLICATION_ALLOWED: 'true' });
  await admin(env, 'POST', '/v1/admin/settings', { publication_enabled: true, reason: 'test go-live' });
  const r1 = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  const r2 = await admin(env, 'POST', `/v1/admin/runs/${r1.json.runId}/compute`, { reason: 'recheck' });
  assert.equal(r2.status, 200); assert.notEqual(r2.json.snapshotId, r1.json.snapshotId);
  const stale = await admin(env, 'POST', '/v1/admin/publish', { snapshotId: r1.json.snapshotId });
  assert.deepEqual([stale.status, stale.json.error], [409, 'not_publishable']);
  assert.equal((await admin(env, 'POST', '/v1/admin/publish', { snapshotId: r2.json.snapshotId })).status, 200);
});

test('a run left in computing by a killed invocation can be recomputed after it goes stale', async () => {
  const { env } = await loaded(5);
  const r = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  await env.DB.prepare("UPDATE reporting_run SET state = 'computing', updated_at = '2026-01-01T00:00:00.000Z' WHERE run_id = ?1").bind(r.json.runId).run();
  const again = await admin(env, 'POST', `/v1/admin/runs/${r.json.runId}/compute`, { reason: 'stale' });
  assert.equal(again.status, 200);
  const detail = await admin(env, 'GET', `/v1/admin/runs/${r.json.runId}`);
  assert.ok(detail.json.transitions.some(t => t.to_state === 'failed' && t.note === 'stale'));
});

test('Insurance Cost treatment cannot be changed through the API before the non-duplication test', async () => {
  const env = await makeEnv();
  for (const v of ['add', 'included']) assert.equal((await admin(env, 'POST', '/v1/admin/settings', { insurance_treatment: v })).status, 400);
  assert.equal((await admin(env, 'POST', '/v1/admin/settings', { insurance_treatment: 'awaiting_confirmation' })).status, 200);
});

test('the normalized Shopify path enforces the privacy contract: unknown note attributes are rejected', async () => {
  const env = await makeEnv();
  const mk = () => normalizeShopifyOrders([gqlOrder({ name: '#900777', createdAt: '2026-09-15T17:00:00Z', subtotal: 10, total: 10,
                                                   lines: [{ sku: 'MG-ALOE', price: 10, vendor: 'Succulents Box' }] })], { timeZone: 'America/Los_Angeles' })[0];
  const bad = mk(); bad.noteAttributes = [{ key: 'Channel', value: 'TikTok' }, { key: 'Gift message', value: 'Synthetic private text' }];
  const r = await ingest(env, '/v1/ingest/shopify', { format: 'normalized', storeTimezone: 'America/Los_Angeles', orders: [bad] });
  assert.deepEqual([r.status, r.json.error], [400, 'customer_data_rejected']);
  assert.ok(!JSON.stringify(r.json).includes('Synthetic private text'));
  const good = mk(); good.noteAttributes = [{ key: 'Channel', value: 'TikTok' }];
  assert.equal((await ingest(env, '/v1/ingest/shopify', { format: 'normalized', storeTimezone: 'America/Los_Angeles', orders: [good] })).status, 200);
  const row = await env.DB.prepare('SELECT note_attributes FROM shopify_order').first();
  assert.deepEqual(JSON.parse(row.note_attributes), [{ key: 'Channel', value: 'TikTok' }]);
});

test('parallel failed logins cannot exceed the limit', async () => {
  const env = await makeEnv();
  const rs = await Promise.all(Array.from({ length: 16 }, () => call(env, 'POST', '/v1/auth/login', { body: { password: 'nope' } })));
  assert.equal(rs.filter(r => r.status === 401).length, 10);
  assert.equal(rs.filter(r => r.status === 429).length, 6);
});

test('backfill plans monthly ranges and completed Monday–Sunday weeks from a parameterized start', () => {
  const p = planBackfill('2026-01-01', null, '2026-09-24');
  assert.equal(p.through, '2026-09-20');
  assert.equal(p.weeks[0], '2025-12-29');                          // week containing Jan 1
  assert.equal(p.weeks.at(-1), '2026-09-14');
  assert.deepEqual(p.months.map(m => m.month), ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);
  assert.deepEqual(p.months.at(-1), { month: '2026-09', from: '2026-09-01', to: '2026-09-20' });
  assert.equal(planBackfill('2025-10-01', null, '2026-09-24').months[0].month, '2025-10');
});

test('backfill computes ingested weeks without snapshots, in bounded steps', async () => {
  const { env } = await loaded(5);
  const dry = await admin(env, 'POST', '/v1/admin/backfill', { from: '2026-09-01', today: '2026-09-24' });
  assert.equal(dry.json.dryRun, true);
  assert.deepEqual(dry.json.weeks.find(w => w.weekStart === WEEK), { weekStart: WEEK, ordersIngested: 5, hasSnapshot: false });
  const run = await admin(env, 'POST', '/v1/admin/backfill', { from: '2026-09-01', today: '2026-09-24', dryRun: false });
  assert.deepEqual(run.json.computed.map(c => c.weekStart), [WEEK]);
  assert.deepEqual(run.json.remaining, []);
});

test('the Carrier Fee vs Rate comparison runs over stored shipments', async () => {
  const { env } = await loaded(20);
  const r = await admin(env, 'POST', '/v1/admin/shipstation-field-comparison', { weeks: [WEEK], observedTotals: { SH10: 6.10 } });
  assert.equal(r.json.comparison.compared, 20);
  assert.equal(r.json.comparison.bothZero, 1);
  assert.equal(r.json.comparison.differences, 19);
  assert.equal(r.json.comparison.differenceSum, -5.7);
  assert.equal(r.json.insurance.outcome, 'add');
});

test('storage monitoring reports usage and flags the 70% review point', async () => {
  const env = await makeEnv({ D1_QUOTA_BYTES: '100000' });
  const r = await admin(env, 'GET', '/v1/admin/storage');
  assert.equal(typeof r.json.bytesUsed, 'number');
  assert.equal(r.json.reviewRetention, true);
});

test('A22: no response body ever contains a secret, a password hash or synthetic customer data', async () => {
  const { env } = await loaded(5);
  await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  await admin(env, 'GET', `/v1/snapshot/${WEEK}?includeDrafts=1`);
  await admin(env, 'GET', '/v1/admin/settings');
  const all = bodies.join('\n');
  for (const needle of [env.INGEST_SECRET, env.ADMIN_SECRET, env.SESSION_SIGNING_KEY, env.DASHBOARD_PASSWORD_HASH,
                        'pbkdf2_sha256', 'SYNTHETIC RECIPIENT', 'synthetic@example.invalid', 'synthetic note']) {
    assert.ok(!all.includes(needle), needle.slice(0, 12));
  }
});
