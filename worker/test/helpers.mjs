/**
 * Shared helpers for the Worker tests: a fresh D1 stand-in with the real
 * migrations, per-run random secrets, and synthetic orders/shipments/catalog.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/index.js';
import { D1Shim } from './d1shim.mjs';
import { hashPassword } from '../src/auth.js';
import { gqlOrder, ssCustom } from '../../tests/fixtures-normalized.mjs';
import { reportRow } from '../../tests/fixtures-shipping-cost.mjs';
import { sanitizeShippingCostReport, parseShippingCostReport } from '../../shared/adapters/shippingCostReport.js';
import { toCsvText } from '../../shared/adapters/shopifyCsv.js';
import { normalizeShopifyOrders } from '../../shared/adapters/shopifyGraphql.js';

/**
 * The Worker has no Shopify API route (format 'graphql' is refused). Tests keep
 * building orders with the synthetic GraphQL-shaped fixture, normalize them here
 * and send them through the manual/backfill `normalized` path instead.
 */
export function viaNormalized({ nodes, ...rest }) {
  return { format: 'normalized', orders: normalizeShopifyOrders(nodes, { timeZone: 'America/Los_Angeles' }), storeTimezone: 'America/Los_Angeles', ...rest };
}

export const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
export const PASSWORD = `synthetic-${crypto.randomUUID()}`;
export const rnd = () => crypto.randomUUID() + crypto.randomUUID();
export const WEEK = '2026-09-14';

export async function makeEnv(extra = {}) {
  return {
    DB: new D1Shim().migrate(MIGRATIONS),
    INGEST_SECRET: rnd(), ADMIN_SECRET: rnd(), SESSION_SIGNING_KEY: rnd(),
    DASHBOARD_PASSWORD_HASH: await hashPassword(PASSWORD, { iterations: 1000 }),
    ALLOWED_ORIGINS: 'https://sb-profit.netlify.app', COOKIE_SAMESITE: 'Strict', PUBLICATION_ALLOWED: 'false',
    // The scheduled-path tests need automation on; worker/wrangler.toml keeps it "false"
    // (tests/c3-controls.test.mjs checks both the file and the refusal).
    AUTOMATION_ENABLED: 'true',
    ...extra,
  };
}

/**
 * C8: readiness counts only what was recorded at or before the tick instant.
 * Tests simulate ticks in the past, while the Worker stamps uploads with the
 * real clock. asOf(env, iso) moves every timestamp later than `iso` to just
 * before it, keeping their order, so "uploaded, then ticked" stays true.
 * Boundary tests set exact timestamps themselves instead. For concurrent calls
 * at different instants, shift once (at the earliest) before firing them.
 */
const CLOCK_COLUMNS = [['ingest_run', ['started_at', 'finished_at']], ['shipping_cost_source_version', ['imported_at', 'decided_at']],
  ['shipping_cost_activation', ['activated_at']], ['catalog_refresh', ['requested_at', 'resolved_at']], ['catalog_reuse_acceptance', ['at']],
  ['schedule_cycle', ['sources_changed_at']]];
export async function asOf(env, iso) {
  const t = Date.parse(iso), real = Date.now(), cut = new Date(t).toISOString();
  for (const [table, cols] of CLOCK_COLUMNS) for (const c of cols) {
    const rows = (await env.DB.prepare(`SELECT rowid AS id, ${c} AS v FROM ${table} WHERE ${c} > ?1`).bind(cut).all()).results || [];
    for (const r of rows) {
      const shifted = new Date(t - 1 - Math.max(0, real - Date.parse(r.v))).toISOString();
      await env.DB.prepare(`UPDATE ${table} SET ${c} = ?2 WHERE rowid = ?1`).bind(r.id, shifted).run();
    }
  }
}
/** Set every clock column of the rows written since `sinceIso` (real clock) to exactly `iso`. */
export async function stampSince(env, sinceIso, iso) {
  for (const [table, cols] of CLOCK_COLUMNS) for (const c of cols) {
    await env.DB.prepare(`UPDATE ${table} SET ${c} = ?2 WHERE ${c} >= ?1`).bind(sinceIso, iso).run();
  }
}

export const bodies = [];
export async function call(env, method, p, { body, headers = {}, cookie } = {}) {
  const h = { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7', ...headers };
  if (cookie) h.Cookie = cookie;
  const res = await worker.fetch(new Request(`https://worker.example${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const text = await res.text();
  bodies.push(text);
  let j = null; try { j = JSON.parse(text); } catch { /* preflight etc. */ }
  return { status: res.status, headers: res.headers, json: j };
}
export const ingest = (env, p, body) => call(env, 'POST', p, { body, headers: { 'X-Ingest-Secret': env.INGEST_SECRET } });
export const admin = async (env, method, p, body) => {
  if (body?.at && env.TEST_HOOKS_ENABLED === 'true') await asOf(env, body.at);     // a simulated tick instant (see asOf)
  return call(env, method, p, { body, headers: { 'X-Admin-Secret': env.ADMIN_SECRET } });
};
export async function sessionCookie(env) {
  const r = await call(env, 'POST', '/v1/auth/login', { body: { password: PASSWORD } });
  assert.equal(r.status, 200);
  return r.headers.get('Set-Cookie').split(';')[0];
}

/** A catalog large enough to pass the Revision 5 vendor-size guard, pricing the fixture SKUs. */
export function catalog({ calathea = 462 } = {}) {
  const v = (name, n, extra = {}) => ({ ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`${name.slice(0, 3).toUpperCase()}-${i}`, { unitCost: 1 }])), ...extra });
  return {
    tables: {
      mcg_total: { PLACEHOLDER: 1 }, product_costs: {}, sku_weights: {}, sb_costs: {},
      hp_supplement: { 'MG-ALOE': 4.5, 'MG-JADE': 6, 'FH-POTHOS': 9 }, hp_by_name: {}, sku_alias: {},
      vendor_costs: { 'Live to Give': v('Live to Give', 30), 'Lively Good': v('Lively Good', 171),
        'Calathea Collective': v('Calathea Collective', calathea), 'Surfside Arrangement': v('Surfside Arrangement', 11),
        'LindaMakes': v('LindaMakes', 396) },
      vendor_index: { LindaMakes: { byLooseSku: {}, byName: {} } },
    },
    meta: { builtAt: '2026-09-21T12:00:00Z', commit: 'test' },
  };
}

export function weekOrders(n = 60) {
  const nodes = [], ship = [];
  for (let i = 0; i < n; i++) {
    const name = `#9${String(i).padStart(5, '0')}`;
    const lines = [{ sku: 'MG-ALOE', price: 10, qty: 2, vendor: 'Succulents Box' }];
    if (i % 5 === 0) lines.push({ sku: 'ROUTEINS', name: 'Shipping Protection by Route - 0.98', price: 0.98, vendor: 'Route' });
    if (i % 7 === 0) lines.push({ sku: 'NOPE-1', price: 5, vendor: 'Nobody' });
    const sub = lines.reduce((s, l) => s + l.price * (l.qty || 1), 0);
    nodes.push(gqlOrder({ name, createdAt: `2026-09-${15 + (i % 5)}T17:00:00Z`, subtotal: sub, shipping: 5, total: sub + 5, lines }));
    ship.push(...ssCustom({ shipment: `SH${i}`, order: name.slice(1), fee: i % 20 === 0 ? '0' : '5.10', rate: i % 20 === 0 ? '0' : '5.40', insurance: i % 10 === 0 ? '1.00' : '' }));
  }
  return { nodes, ship };
}

/**
 * A week with orders, shipments and a VERIFIED catalog refresh for WEEK.
 * `lock` sets the Carrier Fee priority lock (a reasoned, audited setting) so
 * tests about other behaviour can reach `validated`; tests of the lock itself
 * pass lock: false.
 */
/**
 * C3: ingest and accept a Shipping Cost Report for WEEK. `costs` maps order
 * number → cost (dollars) with ship dates on the order dates; orders left out
 * have no report row.
 */
export async function ingestReport(env, entries, { from = WEEK, to = '2026-09-20', exportedAt = '2026-09-21T15:00:00Z' } = {}) {
  const raw = entries.map(e => reportRow({ date: e.date, order: e.order, cost: Number(e.cost).toFixed(2), paid: '5.00' }));
  const s = sanitizeShippingCostReport(raw);
  const p = parseShippingCostReport(s.rows, { requestedFrom: from, requestedTo: to });
  const r = await ingest(env, '/v1/ingest/shipping-cost-report', { format: 'csv_text', text: toCsvText(s.rows, s.columns), requestedFrom: from, requestedTo: to,
    rowCount: p.rowCount, shippingCostTotal: p.shippingCostCents / 100, exportedAt });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  if (r.json.status === 'pending_review') assert.equal((await admin(env, 'POST', `/v1/admin/shipping-cost/versions/${r.json.versionId}/accept`, { reason: 'test: reviewed' })).status, 200);
  return r.json;
}

/**
 * Test-only stand-in for the future Shipping Cost Report verification checklist:
 * the API cannot set the flag true before that commit, so tests of the
 * publication machinery write it straight into the D1 stand-in.
 */
export async function markShippingSourceVerifiedForTests(env) {
  await env.DB.prepare("UPDATE settings SET value = 'true' WHERE key = 'shipping_cost_report_source_verified'").run();
}

export async function loaded(n = 60, extra = {}, { lock = true, refresh = true, shippingReport = true, verified = true, reportMissingEvery = 0 } = {}) {
  const env = await makeEnv(extra);
  const { nodes, ship } = weekOrders(n);
  if (lock) assert.equal((await admin(env, 'POST', '/v1/admin/settings', { carrier_fee_priority_locked: true, reason: 'test: priority locked' })).status, 200);
  const rf = refresh ? (await admin(env, 'POST', '/v1/admin/catalog-refresh', { weekStart: WEEK })).json.refreshId : null;
  const cat = catalog(); if (rf) cat.meta.refreshId = rf;
  assert.equal((await ingest(env, '/v1/ingest/catalog', cat)).status, 200);
  assert.equal((await ingest(env, '/v1/ingest/shopify', viaNormalized({ nodes, weekStart: WEEK }))).status, 200);
  assert.equal((await ingest(env, '/v1/ingest/shipstation', { format: 'rows', rows: ship, weekStart: WEEK })).status, 200);
  // C3: the expense source. Every order has a report row (the mapping export's
  // zero-cost labels are costed here), so order-level coverage is complete.
  // `reportMissingEvery: k` leaves every k-th order without a row (coverage gaps).
  if (shippingReport) await ingestReport(env, nodes.map((o, i) => ({ order: o.name.slice(1), date: `2026-09-${15 + (i % 5)}`, cost: i % 20 === 0 ? 5.40 : 5.10 }))
    .filter((_, i) => !(reportMissingEvery && i % reportMissingEvery === 0)));
  if (shippingReport && verified) await markShippingSourceVerifiedForTests(env);
  return { env, nodes, ship };
}

