/**
 * Revision 6 acceptance tests (Worker level). All data is synthetic.
 * Publication locks stay off in the repository; tests that exercise the
 * publish path turn them on inside a throwaway in-memory database only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WEEK, makeEnv, call, ingest, admin, sessionCookie, catalog, weekOrders, loaded, viaNormalized } from './helpers.mjs';
import { gqlOrder, ssCustom } from '../../tests/fixtures-normalized.mjs';
import { normalizeShopifyOrders } from '../../shared/adapters/shopifyGraphql.js';

const PREV = '2026-09-07';                                   // the week before WEEK
const goLive = env => admin(env, 'POST', '/v1/admin/settings', { publication_enabled: true, reason: 'test go-live' });
const snapRow = (env, id) => env.DB.prepare('SELECT * FROM snapshot WHERE snapshot_id = ?1').bind(id).first();
const runRow = (env, id) => env.DB.prepare('SELECT * FROM reporting_run WHERE run_id = ?1').bind(id).first();

/** Orders + shipments for the week before WEEK, with their own verified catalog refresh. */
async function loadPrevWeek(env, n = 10) {
  const nodes = [], ship = [];
  for (let i = 0; i < n; i++) {
    const name = `#8${String(i).padStart(5, '0')}`;
    nodes.push(gqlOrder({ name, createdAt: `2026-09-${String(8 + (i % 5)).padStart(2, '0')}T17:00:00Z`, subtotal: 20, shipping: 5, total: 25,
                          lines: [{ sku: 'MG-ALOE', price: 10, qty: 2, vendor: 'Succulents Box' }] }));
    ship.push(...ssCustom({ shipment: `P${i}`, order: name.slice(1), fee: '5.10', rate: '5.40' }));
  }
  const rf = (await admin(env, 'POST', '/v1/admin/catalog-refresh', { weekStart: PREV })).json.refreshId;
  const cat = catalog(); cat.meta.refreshId = rf;
  assert.equal((await ingest(env, '/v1/ingest/catalog', cat)).json.refresh.status, 'fulfilled');   // duplicate content still verifies
  assert.equal((await ingest(env, '/v1/ingest/shopify', viaNormalized({ nodes, weekStart: PREV }))).status, 200);
  assert.equal((await ingest(env, '/v1/ingest/shipstation', { format: 'rows', rows: ship, weekStart: PREV })).status, 200);
  return { nodes, ship };
}

// ─── 2. Carrier Fee priority ──────────────────────────────────────────────────

test('an unlocked Carrier Fee priority blocks the gate, and both publication switches cannot override it', async () => {
  const { env } = await loaded(20, { PUBLICATION_ALLOWED: 'true' }, { lock: false });
  await goLive(env);
  const r = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  assert.equal(r.json.state, 'blocked');
  assert.ok(r.json.gate.failures.some(f => f.code === 'carrier_fee_priority'));
  const p = await admin(env, 'POST', '/v1/admin/publish', { snapshotId: r.json.snapshotId });
  assert.deepEqual([p.status, p.json.detail.reason], [409, 'carrier_fee_priority_unlocked']);

  // Lock, recompute → validated. Then unlock again: the stored gate passed, but
  // publication still refuses because the CURRENT lock is off.
  assert.equal((await admin(env, 'POST', '/v1/admin/settings', { carrier_fee_priority_locked: true })).status, 400);   // reason required
  await admin(env, 'POST', '/v1/admin/settings', { carrier_fee_priority_locked: true, reason: 'zero-Rate investigation closed (test)' });
  const r2 = await admin(env, 'POST', `/v1/admin/runs/${r.json.runId}/compute`, { reason: 'after lock' });
  assert.equal(r2.json.state, 'validated', JSON.stringify(r2.json.gate.failures));
  await admin(env, 'POST', '/v1/admin/settings', { carrier_fee_priority_locked: false, reason: 'reopened (test)' });
  const p2 = await admin(env, 'POST', '/v1/admin/publish', { snapshotId: r2.json.snapshotId });
  assert.deepEqual([p2.status, p2.json.detail.reason], [409, 'carrier_fee_priority_unlocked']);
  assert.equal((await snapRow(env, r2.json.snapshotId)).status, 'draft');

  const audit = (await env.DB.prepare("SELECT key, new_value, reason FROM settings_audit WHERE key = 'carrier_fee_priority_locked' ORDER BY id").all()).results;
  assert.deepEqual(audit.map(a => [a.new_value, a.reason]), [['true', 'zero-Rate investigation closed (test)'], ['false', 'reopened (test)']]);
});

// ─── 3. Catalog versioning ────────────────────────────────────────────────────

test('catalog rule 1+2: a new run records one catalog; retry and recompute reuse it even after a newer catalog arrives', async () => {
  const { env } = await loaded(20);
  const r1 = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  const run = await runRow(env, r1.json.runId);
  const info = JSON.parse(run.catalog_info);
  assert.equal(info.basis, 'week_refresh');
  assert.equal(r1.json.gate.catalog.freshness.status, 'current');
  assert.ok(r1.json.gate.catalog.expectedRefreshId && r1.json.gate.catalog.capturedAt);

  const newer = catalog(); newer.tables.hp_supplement['MG-ALOE'] = 9.99;
  assert.equal((await ingest(env, '/v1/ingest/catalog', newer)).json.accepted, true);
  const r2 = await admin(env, 'POST', `/v1/admin/runs/${r1.json.runId}/compute`, { reason: 'retry' });
  assert.equal((await snapRow(env, r2.json.snapshotId)).catalog_rev, info.rev);
  assert.equal(r2.json.gate.catalog.selectedRev, info.rev);
});

test('catalog rule 3: revising a published week keeps the published catalog; rule 4: restatement is explicit and audited', async () => {
  const { env } = await loaded(20, { PUBLICATION_ALLOWED: 'true' });
  await goLive(env);
  const r1 = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  assert.equal((await admin(env, 'POST', '/v1/admin/publish', { snapshotId: r1.json.snapshotId })).status, 200);
  const pubRev = (await snapRow(env, r1.json.snapshotId)).catalog_rev;
  const cookie = await sessionCookie(env);
  const before = (await call(env, 'GET', `/v1/snapshot/${WEEK}`, { cookie })).json.totals;

  const newer = catalog(); newer.tables.hp_supplement['MG-ALOE'] = 9.99;
  const nc = (await ingest(env, '/v1/ingest/catalog', newer)).json;
  const rev = await admin(env, 'POST', '/v1/admin/revise', { weekStart: WEEK, reason: 'late shipment data (test)' });
  const revSnap = await snapRow(env, rev.json.snapshotId);
  assert.equal(revSnap.catalog_rev, pubRev, 'an ordinary revision must not adopt the newer catalog');
  assert.equal(JSON.parse(revSnap.catalog_info).basis, 'published_snapshot');
  assert.equal(JSON.parse(revSnap.catalog_info).freshness.status, 'intentionally_reused');
  const revTotals = (await admin(env, 'GET', `/v1/snapshot/${WEEK}?includeDrafts=1&revision=${rev.json.revision}`)).json.totals;
  assert.equal(revTotals.knownProductCogs, before.knownProductCogs);

  assert.equal((await admin(env, 'POST', '/v1/admin/restate-costs', { weekStart: WEEK, reason: 'short' })).status, 400);
  assert.equal((await admin(env, 'POST', '/v1/admin/restate-costs', { weekStart: WEEK, reason: 'Vendor corrected MG-ALOE cost (test)', actor: 'duc' })).status, 400);  // no caller-asserted actor
  const rs = await admin(env, 'POST', '/v1/admin/restate-costs', { weekStart: WEEK, reason: 'Vendor corrected MG-ALOE cost (test)', actorLabel: 'duc' });
  assert.equal(rs.status, 200, JSON.stringify(rs.json));
  assert.deepEqual([rs.json.restatement.fromCatalogRev, rs.json.restatement.toCatalogRev], [pubRev, nc.catalogRev]);
  assert.equal(rs.json.snapshotStatus === 'published', false);                            // never auto-published
  const row = await env.DB.prepare('SELECT * FROM cost_restatement').first();
  assert.deepEqual([row.week_start, row.from_catalog_rev, row.to_catalog_rev, row.actor_class, row.actor_label, row.reason],
                   [WEEK, pubRev, nc.catalogRev, 'admin_secret', 'duc', 'Vendor corrected MG-ALOE cost (test)']);
  assert.equal(row.run_id, rs.json.runId);
  const rsSnap = await snapRow(env, rs.json.snapshotId);
  assert.equal(JSON.parse(rsSnap.catalog_info).freshness.status, 'restated');
  assert.ok((await admin(env, 'GET', `/v1/snapshot/${WEEK}?includeDrafts=1&revision=${rsSnap.revision}`)).json.totals.knownProductCogs > before.knownProductCogs);
  assert.equal((await call(env, 'GET', `/v1/snapshot/${WEEK}`, { cookie })).json.revision, 1);      // published view unchanged
  assert.equal((await admin(env, 'POST', '/v1/admin/restate-costs', { weekStart: WEEK, catalogRev: pubRev, reason: 'back to the published catalog' })).status, 409);
});

// ─── 4. Atomic, recoverable publish ───────────────────────────────────────────

test('a failure inside the publish transaction leaves nothing half-published, and a retry completes it', async () => {
  const { env } = await loaded(20, { PUBLICATION_ALLOWED: 'true' });
  await goLive(env);
  const r = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  env.DB.failNextBatchAt(/UPDATE reporting_run SET state = 'published'/);
  const p = await admin(env, 'POST', '/v1/admin/publish', { snapshotId: r.json.snapshotId });
  assert.equal(p.status, 500);
  assert.equal((await snapRow(env, r.json.snapshotId)).status, 'draft');                 // rolled back together
  assert.equal((await runRow(env, r.json.runId)).state, 'validated');
  const retry = await admin(env, 'POST', '/v1/admin/publish', { snapshotId: r.json.snapshotId });
  assert.equal(retry.status, 200);
  assert.equal((await snapRow(env, r.json.snapshotId)).status, 'published');
  assert.equal((await runRow(env, r.json.runId)).state, 'published');
  const tr = (await env.DB.prepare("SELECT COUNT(*) AS n FROM run_transition WHERE run_id = ?1 AND to_state = 'published'").bind(r.json.runId).first()).n;
  assert.equal(tr, 1);
});

test('a publish retry repairs a snapshot that is published while its run still says validated', async () => {
  const { env } = await loaded(20, { PUBLICATION_ALLOWED: 'true' });
  await goLive(env);
  const r = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  // The state an interrupted two-step publish (earlier build) could leave behind.
  await env.DB.prepare("UPDATE snapshot SET status = 'published', published_at = '2026-09-22T00:00:00Z' WHERE snapshot_id = ?1").bind(r.json.snapshotId).run();
  assert.equal((await runRow(env, r.json.runId)).state, 'validated');
  const p = await admin(env, 'POST', '/v1/admin/publish', { snapshotId: r.json.snapshotId });
  assert.equal(p.status, 200); assert.equal(p.json.repaired, true);
  assert.equal((await runRow(env, r.json.runId)).state, 'published');
  const again = await admin(env, 'POST', '/v1/admin/publish', { snapshotId: r.json.snapshotId });
  assert.equal(again.json.alreadyPublished, true);
  const notes = (await env.DB.prepare('SELECT note FROM run_transition WHERE run_id = ?1 AND to_state = ?2').bind(r.json.runId, 'published').all()).results;
  assert.deepEqual(notes.map(n => n.note), ['repaired: snapshot was already published']);
});

// ─── 5. Comparisons use published history only ────────────────────────────────

test('the published narrative never compares with a draft or blocked prior week', async () => {
  const { env } = await loaded(20, { PUBLICATION_ALLOWED: 'true' });
  await goLive(env);
  await loadPrevWeek(env);
  const a = await admin(env, 'POST', '/v1/admin/runs', { weekStart: PREV });
  assert.equal(a.json.state, 'validated');

  // Prior week only has a draft → no comparison in the stored narrative.
  const w1 = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  const s1 = (await admin(env, 'GET', `/v1/snapshot/${WEEK}?includeDrafts=1`)).json;
  assert.equal(s1.narrative.comparison, null);
  assert.ok(!s1.narrative.points.some(p => /^Versus the week/.test(p)));
  assert.equal(s1.draftComparisonPreview.basis, 'draft');                               // admin preview, labelled
  assert.match(s1.draftComparisonPreview.label, /DRAFT PREVIEW/);

  // Publishing the prior week makes this draft's comparison stale → refused until recomputed.
  assert.equal((await admin(env, 'POST', '/v1/admin/publish', { snapshotId: a.json.snapshotId })).status, 200);
  const stale = await admin(env, 'POST', '/v1/admin/publish', { snapshotId: w1.json.snapshotId });
  assert.deepEqual([stale.status, stale.json.error], [409, 'comparison_stale']);

  // A newer BLOCKED revision of the prior week must not replace the published basis.
  await admin(env, 'POST', '/v1/admin/settings', { carrier_fee_priority_locked: false, reason: 'force a blocked revision (test)' });
  const ab = await admin(env, 'POST', '/v1/admin/revise', { weekStart: PREV, reason: 'blocked revision (test)' });
  assert.equal(ab.json.snapshotStatus, 'blocked');
  await admin(env, 'POST', '/v1/admin/settings', { carrier_fee_priority_locked: true, reason: 'restore (test)' });

  const w2 = await admin(env, 'POST', `/v1/admin/runs/${w1.json.runId}/compute`, { reason: 'after prior week published' });
  const s2 = (await admin(env, 'GET', `/v1/snapshot/${WEEK}?includeDrafts=1`)).json;
  assert.deepEqual(s2.narrative.comparison, { basis: 'published', weekStart: PREV, snapshotId: a.json.snapshotId });
  assert.equal(s2.draftComparisonPreview.basis, 'blocked');
  assert.equal((await admin(env, 'POST', '/v1/admin/publish', { snapshotId: w2.json.snapshotId })).status, 200);
  const cookie = await sessionCookie(env);
  const pub = (await call(env, 'GET', `/v1/snapshot/${WEEK}`, { cookie })).json;
  assert.equal(pub.narrative.comparison.snapshotId, a.json.snapshotId);
  assert.equal(pub.draftComparisonPreview, undefined);                                  // sessions never see the preview
  const hist = (await call(env, 'GET', '/v1/history', { cookie })).json.weeks;
  assert.ok(hist.every(h => h.status === 'published'));
});

// ─── 6. Catalog freshness ─────────────────────────────────────────────────────

test('stale catalog: no refresh, a pending refresh, and a rejected refresh all block; accepted reuse is audited', async () => {
  // No refresh recorded for the week.
  const { env } = await loaded(20, {}, { refresh: false });
  const r = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  assert.equal(r.json.state, 'blocked');
  const f = r.json.gate.failures.find(x => x.code === 'catalog_stale');
  assert.ok(f, JSON.stringify(r.json.gate.failures));
  assert.deepEqual([r.json.gate.catalog.freshness.status, r.json.gate.catalog.freshness.reason, r.json.gate.catalog.basis],
                   ['stale', 'no_refresh_for_this_week', 'latest_accepted']);
  assert.ok(r.json.gate.catalog.selectedRev && r.json.gate.catalog.capturedAt);

  // Accepting reuse needs a real reason, is recorded, and is visible on the gate.
  assert.equal((await admin(env, 'POST', `/v1/admin/runs/${r.json.runId}/compute`, { acceptCatalogReuse: { reason: 'ok' } })).status, 400);
  const ok = await admin(env, 'POST', `/v1/admin/runs/${r.json.runId}/compute`, { acceptCatalogReuse: { reason: 'Netlify build down; sheets unchanged since last week' } });
  assert.equal(ok.json.gate.catalog.freshness.status, 'reused_accepted');
  assert.ok(!ok.json.gate.failures.some(x => x.code === 'catalog_stale'));
  assert.ok(ok.json.gate.warnings.some(x => x.code === 'catalog_reused'));
  const acc = await env.DB.prepare('SELECT * FROM catalog_reuse_acceptance').first();
  assert.equal(acc.run_id, r.json.runId);

  // A pending refresh is not ready; a rejected one is stale.
  const env2 = await makeEnv();
  await admin(env2, 'POST', '/v1/admin/settings', { carrier_fee_priority_locked: true, reason: 'test' });
  assert.equal((await ingest(env2, '/v1/ingest/catalog', catalog())).json.accepted, true);
  const rf = (await admin(env2, 'POST', '/v1/admin/catalog-refresh', { weekStart: WEEK })).json.refreshId;
  assert.equal((await admin(env2, 'GET', `/v1/admin/catalog-refresh/${rf}`)).json.status, 'pending');
  const ready = (await admin(env2, 'GET', `/v1/admin/readiness?weekStart=${WEEK}`)).json;
  assert.ok(ready.missing.includes('catalog_refresh:pending'));
  const shrunk = catalog({ calathea: 300 }); shrunk.meta.refreshId = rf;
  assert.equal((await ingest(env2, '/v1/ingest/catalog', shrunk)).json.refresh.status, 'rejected');
  assert.equal((await admin(env2, 'GET', `/v1/admin/catalog-refresh/${rf}`)).json.status, 'rejected');
  const { nodes, ship } = weekOrders(20);
  await ingest(env2, '/v1/ingest/shopify', viaNormalized({ nodes, weekStart: WEEK }));
  await ingest(env2, '/v1/ingest/shipstation', { format: 'rows', rows: ship, weekStart: WEEK });
  const r2 = await admin(env2, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  assert.deepEqual([r2.json.state, r2.json.gate.catalog.freshness.reason], ['blocked', 'refresh_rejected']);
});

// ─── 7. Earlier weeks touched by this cycle ───────────────────────────────────

test('earlier weeks touched by Shopify updates and late shipments become unpublished draft revisions', async () => {
  const { env } = await loaded(20, { PUBLICATION_ALLOWED: 'true' });
  await goLive(env);
  const { nodes: prevNodes } = await loadPrevWeek(env, 10);
  const a = await admin(env, 'POST', '/v1/admin/runs', { weekStart: PREV });
  assert.equal((await admin(env, 'POST', '/v1/admin/publish', { snapshotId: a.json.snapshotId })).status, 200);

  // This cycle (WEEK): an earlier order was refunded; a late shipment arrived for another.
  const refunded = { ...prevNodes[0], totalRefundedSet: { shopMoney: { amount: '5.00', currencyCode: 'USD' } },
    refunds: [{ id: 'gid://shopify/Refund/800000x', createdAt: '2026-09-16T10:00:00Z', totalRefundedSet: { shopMoney: { amount: '5.00', currencyCode: 'USD' } },
                refundLineItems: { nodes: [] }, refundShippingLines: { nodes: [{ subtotalAmountSet: { shopMoney: { amount: '5.00', currencyCode: 'USD' } }, taxAmountSet: { shopMoney: { amount: '0', currencyCode: 'USD' } } }] },
                orderAdjustments: { nodes: [] } }] };
  const up = await ingest(env, '/v1/ingest/shopify', viaNormalized({ mode: 'updated_since', nodes: [refunded, prevNodes[1]], weekStart: WEEK }));
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.deepEqual(up.json.weeksTouched, { [PREV]: 1 });                                  // the unchanged order is a duplicate
  const late = await ingest(env, '/v1/ingest/shipstation', { format: 'rows', weekStart: WEEK,
    rows: ssCustom({ shipment: 'LATE1', order: '800002', fee: '1.00', rate: '1.00' }) });
  assert.deepEqual(late.json.weeksTouched, { [PREV]: 1 });

  const rv = await admin(env, 'POST', '/v1/admin/revise-touched', { weekStart: WEEK });
  assert.equal(rv.status, 200, JSON.stringify(rv.json));
  assert.equal(rv.json.revised.length, 1);
  const x = rv.json.revised[0];
  assert.equal(x.weekStart, PREV);
  assert.equal(x.published, false);
  assert.notEqual(x.snapshotStatus, 'published');
  assert.match(x.reason, /2 changed record\(s\) from shopify:updated_since, shipstation/);
  const cookie = await sessionCookie(env);
  assert.equal((await call(env, 'GET', `/v1/snapshot/${PREV}`, { cookie })).json.snapshotId, a.json.snapshotId);   // published unchanged
  const again = await admin(env, 'POST', '/v1/admin/revise-touched', { weekStart: WEEK });
  assert.deepEqual([again.json.revised.length, again.json.skipped[0].reason], [0, 'already_revised']);
  // A touched week with no snapshot yet is reported, not computed.
  await ingest(env, '/v1/ingest/shopify', viaNormalized({ mode: 'updated_since', weekStart: WEEK,
    nodes: [gqlOrder({ name: '#700001', createdAt: '2026-08-31T17:00:00Z', subtotal: 10, total: 10, lines: [{ sku: 'MG-ALOE', price: 10, vendor: 'Succulents Box' }] })] }));
  const third = await admin(env, 'POST', '/v1/admin/revise-touched', { weekStart: WEEK });
  assert.ok(third.json.skipped.some(s => s.weekStart === '2026-08-31' && s.reason === 'no_snapshot_yet'));
});

// ─── 8. HPD pass-through is labelled, never complete ──────────────────────────

test('HPD pass-through is stored as assumed and never reported as confirmed actual shipping', async () => {
  const env = await makeEnv();
  await admin(env, 'POST', '/v1/admin/settings', { carrier_fee_priority_locked: true, reason: 'test' });
  const rf = (await admin(env, 'POST', '/v1/admin/catalog-refresh', { weekStart: WEEK })).json.refreshId;
  const cat = catalog(); cat.meta.refreshId = rf;
  await ingest(env, '/v1/ingest/catalog', cat);
  const nodes = [gqlOrder({ name: '#900500', createdAt: '2026-09-15T17:00:00Z', subtotal: 9, shipping: 6, total: 15,
                            lines: [{ sku: 'FH-POTHOS', price: 9, vendor: 'House Plant Dropship' }] })];
  await ingest(env, '/v1/ingest/shopify', viaNormalized({ nodes, weekStart: WEEK }));
  const r = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  const s = (await admin(env, 'GET', `/v1/snapshot/${WEEK}?includeDrafts=1`)).json;
  assert.equal(s.totals.hpdOrdersPassThrough, 1);
  assert.equal(s.totals.hpdShippingBasis, 'hpd_pass_through_assumed');
  assert.notEqual(s.totals.profitabilityStatus, 'complete');
  assert.match(s.narrative.headline, /^Provisional/);
  assert.ok(s.totals.labels.notes.some(n => /^Assumes HP Dropship shipping expense/.test(n)));
  assert.ok(r.json.gate.warnings.some(w => w.code === 'hpd_pass_through_assumed'));
  const o = (await admin(env, 'GET', `/v1/snapshot/${WEEK}/orders/${encodeURIComponent('#900500')}?includeDrafts=1`)).json;
  assert.deepEqual([o.order.profitabilityStatus, o.order.hpdShippingBasis], ['provisional_hpd_pass_through', 'hpd_pass_through_assumed']);

  // With the HPD actual ingested, the same order is hpd_actual.
  const text = ['Date - Order Date,Order - Number,Carrier - Service Selected,Item - Qty,Item - SKU,Notes - From Buyer,Actual Net Terms Cost (Labor + Carrier Shipping),Prepaid Fixed Price,Cost Difference (Net Terms - Prepaid)',
    '2026-09-15,HPD-5,USPS,1,FH-POTHOS,#900500,7.10,6.00,1.10'].join('\n');
  await ingest(env, '/v1/ingest/hpd', { format: 'csv_text', text, weekStart: WEEK });
  await admin(env, 'POST', `/v1/admin/runs/${r.json.runId}/compute`, { reason: 'HPD log arrived' });
  const s2 = (await admin(env, 'GET', `/v1/snapshot/${WEEK}?includeDrafts=1`)).json;
  assert.deepEqual([s2.totals.hpdOrdersActual, s2.totals.hpdOrdersPassThrough, s2.totals.hpdShippingBasis], [1, 0, 'hpd_actual']);
});

// ─── 10. No staff identity or customer data at rest ───────────────────────────

test('no staff email, customer name, address or buyer note is stored anywhere in D1', async () => {
  const env = await makeEnv();
  const STAFF = 'staff.person@example.invalid', NAME = 'Synthetic Recipient Zed', STREET = '1 Synthetic Street', NOTE = 'synthetic buyer note xyz';
  const rows = ssCustom({ shipment: 'X1', order: '900001', fee: '5', extra: { 'Created By': STAFF, 'Recipient Name': NAME, 'Ship To - Address 1': STREET,
                                                                             'Ship To - Email': STAFF } });
  const r = await ingest(env, '/v1/ingest/shipstation', { format: 'rows', rows });
  assert.equal(r.status, 200);
  assert.ok(!JSON.stringify(r.json).includes(STAFF) && !JSON.stringify(r.json).includes(NAME));
  const text = ['Date - Order Date,Order - Number,Carrier - Service Selected,Ship To - State,Item - Qty,Item - SKU,Notes - From Buyer,Actual Net Terms Cost (Labor + Carrier Shipping),Prepaid Fixed Price,Cost Difference (Net Terms - Prepaid)',
    `2026-09-15,HPD-1,USPS,ZZ,1,FH-POTHOS,"#900001 ${NOTE}",7.10,6.00,1.10`].join('\n');
  await ingest(env, '/v1/ingest/hpd', { format: 'csv_text', text });
  const bad = gqlOrder({ name: '#900002', subtotal: 1, total: 1, lines: [{ sku: 'A', price: 1 }] });
  const [badOrder] = normalizeShopifyOrders([bad], { timeZone: 'America/Los_Angeles' });
  badOrder.customer = { firstName: NAME }; badOrder.email = STAFF;
  assert.equal((await ingest(env, '/v1/ingest/shopify', { format: 'normalized', storeTimezone: 'America/Los_Angeles', orders: [badOrder] })).status, 400);

  assert.equal((await env.DB.prepare('SELECT created_by_class FROM shipment').first()).created_by_class, 'person');
  const cols = (await env.DB.prepare("SELECT name FROM pragma_table_info('shipment')").all()).results.map(c => c.name);
  assert.ok(!cols.includes('created_by'));
  const tables = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).results.map(t => t.name);
  for (const t of tables) {
    const dump = JSON.stringify((await env.DB.prepare(`SELECT * FROM "${t}"`).all()).results);
    for (const needle of [STAFF, NAME, STREET, NOTE, 'SYNTHETIC RECIPIENT', 'packer1']) assert.ok(!dump.includes(needle), `${needle} found in ${t}`);
  }
});

// ─── 1. Scheduled compute: not before Monday 15:30, only when every source is ready ──

test('a scheduled compute waits for its slot and for every required source, and runs once per week', async () => {
  const { env } = await loaded(20);
  const early = await admin(env, 'POST', '/v1/admin/runs', { weekStart: '2099-01-05', trigger: 'schedule' });
  assert.deepEqual([early.status, early.json.error], [409, 'too_early']);

  const notReady = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK, trigger: 'schedule' });
  assert.deepEqual([notReady.status, notReady.json.error], [409, 'sources_not_ready']);
  assert.deepEqual(notReady.json.detail.missing, ['shopify_updates:missing']);

  assert.equal((await ingest(env, '/v1/ingest/shopify', viaNormalized({ mode: 'updated_since', nodes: [], weekStart: WEEK }))).status, 200);
  const ready = (await admin(env, 'GET', `/v1/admin/readiness?weekStart=${WEEK}`)).json;
  assert.equal(ready.ready, true, JSON.stringify(ready.missing));
  assert.equal(ready.scheduledAt, '2026-09-21T08:30:00.000Z');
  assert.equal(ready.sources.hpd.required, false);

  const r1 = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK, trigger: 'schedule', actorLabel: 'make:S4' });
  assert.equal(r1.status, 200, JSON.stringify(r1.json));
  const r2 = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK, trigger: 'schedule', actorLabel: 'make:S4' });
  assert.deepEqual([r2.json.runId, r2.json.existing], [r1.json.runId, true]);        // a Make retry does not double-compute

  const plan = (await call(env, 'GET', '/v1/ingest/week-plan?at=2026-09-21T08:30:00Z', { headers: { 'X-Ingest-Secret': env.INGEST_SECRET } })).json;
  assert.deepEqual([plan.weekStart, plan.scheduledAtLocal, plan.due], [WEEK, '2026-09-21 15:30 Asia/Ho_Chi_Minh', true]);
});

// ─── Review follow-ups ────────────────────────────────────────────────────────

test('a later run cannot launder a stale catalog: an unpublished stale anchor stays stale', async () => {
  const { env } = await loaded(20, {}, { refresh: false });
  const r1 = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  assert.equal(r1.json.gate.catalog.freshness.status, 'stale');
  for (const [p, b] of [['/v1/admin/revise', { weekStart: WEEK, reason: 'second look (test)' }], ['/v1/admin/runs', { weekStart: WEEK }]]) {
    const r = await admin(env, 'POST', p, b);
    assert.equal(r.json.state, 'blocked', p);
    assert.deepEqual([r.json.gate.catalog.basis, r.json.gate.catalog.freshness.status, r.json.gate.catalog.freshness.reason],
                     ['previous_snapshot', 'stale', 'inherited_stale_catalog'], p);
  }
  // Once reuse is accepted on a run, later revisions inherit that accepted state.
  const acc = await admin(env, 'POST', `/v1/admin/runs/${r1.json.runId}/compute`, { acceptCatalogReuse: { reason: 'sheets unchanged; build outage (test)' } });
  assert.equal(acc.json.gate.catalog.freshness.status, 'reused_accepted');
  const r3 = await admin(env, 'POST', '/v1/admin/revise', { weekStart: WEEK, reason: 'after acceptance (test)' });
  assert.equal(r3.json.gate.catalog.freshness.status, 'intentionally_reused');
});

test('only the newest revision of a week can be published (no silent rollback of a restatement)', async () => {
  const { env } = await loaded(20, { PUBLICATION_ALLOWED: 'true' });
  await goLive(env);
  const r1 = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK });
  const newer = catalog(); newer.tables.hp_supplement['MG-ALOE'] = 9.99;
  await ingest(env, '/v1/ingest/catalog', newer);
  assert.equal((await admin(env, 'POST', '/v1/admin/publish', { snapshotId: r1.json.snapshotId })).status, 200);
  const rs = await admin(env, 'POST', '/v1/admin/restate-costs', { weekStart: WEEK, reason: 'vendor price update (test)' });
  assert.equal((await admin(env, 'POST', '/v1/admin/publish', { snapshotId: rs.json.snapshotId })).status, 200);
  // A second, older validated draft of the week must not be publishable over rs.
  const other = await admin(env, 'POST', '/v1/admin/revise', { weekStart: WEEK, reason: 'extra draft (test)' });
  const again = await admin(env, 'POST', '/v1/admin/restate-costs', { weekStart: WEEK, catalogRev: (await snapRow(env, r1.json.snapshotId)).catalog_rev, reason: 'try going back (test)' });
  assert.equal(again.status, 200);
  const older = await admin(env, 'POST', '/v1/admin/publish', { snapshotId: other.json.snapshotId });
  assert.deepEqual([older.status, older.json.error], [409, 'not_latest_revision']);
  assert.equal((await snapRow(env, rs.json.snapshotId)).status, 'published');
});

test('a failed touched-week revision is retried on the next call', async () => {
  const { env } = await loaded(20);
  const { nodes: prevNodes } = await loadPrevWeek(env, 3);
  await admin(env, 'POST', '/v1/admin/runs', { weekStart: PREV });
  const changed = { ...prevNodes[0], tags: ['prepaid'] };             // an approved tag: a real content change
  await ingest(env, '/v1/ingest/shopify', viaNormalized({ mode: 'updated_since', nodes: [changed], weekStart: WEEK }));
  env.DB.failNextBatchAt(/INSERT INTO snapshot \(/);
  const first = await admin(env, 'POST', '/v1/admin/revise-touched', { weekStart: WEEK });
  assert.ok(first.json.revised[0].error);
  const second = await admin(env, 'POST', '/v1/admin/revise-touched', { weekStart: WEEK });
  assert.equal(second.json.revised.length, 1);
  assert.ok(second.json.revised[0].snapshotId);
});

test('sessions see the catalog basis and freshness but not the acceptance reason or actor', async () => {
  const { env } = await loaded(20, { PUBLICATION_ALLOWED: 'true' }, { refresh: false });
  await goLive(env);
  const r = await admin(env, 'POST', '/v1/admin/runs', { weekStart: WEEK, acceptCatalogReuse: { reason: 'private operator note (test)' }, actorLabel: 'duc' });
  assert.equal(r.json.state, 'validated', JSON.stringify(r.json.gate.failures));
  assert.equal((await admin(env, 'POST', '/v1/admin/publish', { snapshotId: r.json.snapshotId })).status, 200);
  const cookie = await sessionCookie(env);
  const pub = await call(env, 'GET', `/v1/snapshot/${WEEK}`, { cookie });
  assert.deepEqual(pub.json.catalog.freshness, { status: 'reused_accepted' });
  assert.ok(!JSON.stringify(pub.json).includes('private operator note'));
  const adm = await admin(env, 'GET', `/v1/snapshot/${WEEK}`);
  assert.equal(adm.json.catalog.freshness.acceptance.reason, 'private operator note (test)');
});

test('re-pushing older identical catalog content makes it the latest again', async () => {
  const env = await makeEnv();
  const a = (await ingest(env, '/v1/ingest/catalog', catalog())).json.catalogRev;
  const b = catalog(); b.tables.hp_supplement['MG-ALOE'] = 7;
  const brev = (await ingest(env, '/v1/ingest/catalog', b)).json.catalogRev;
  await new Promise(r => setTimeout(r, 5));
  assert.equal((await ingest(env, '/v1/ingest/catalog', catalog())).json.duplicates, 1);
  const latest = await env.DB.prepare("SELECT catalog_rev FROM cost_catalog WHERE status = 'accepted' ORDER BY COALESCE(last_pushed_at, captured_at) DESC LIMIT 1").first();
  assert.notEqual(a, brev);
  assert.equal(latest.catalog_rev, a);
});
