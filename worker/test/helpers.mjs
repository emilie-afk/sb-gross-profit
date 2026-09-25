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
    ...extra,
  };
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
export const admin = (env, method, p, body) => call(env, method, p, { body, headers: { 'X-Admin-Secret': env.ADMIN_SECRET } });
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
export async function loaded(n = 60, extra = {}, { lock = true, refresh = true } = {}) {
  const env = await makeEnv(extra);
  const { nodes, ship } = weekOrders(n);
  if (lock) assert.equal((await admin(env, 'POST', '/v1/admin/settings', { carrier_fee_priority_locked: true, reason: 'test: priority locked' })).status, 200);
  const rf = refresh ? (await admin(env, 'POST', '/v1/admin/catalog-refresh', { weekStart: WEEK })).json.refreshId : null;
  const cat = catalog(); if (rf) cat.meta.refreshId = rf;
  assert.equal((await ingest(env, '/v1/ingest/catalog', cat)).status, 200);
  assert.equal((await ingest(env, '/v1/ingest/shopify', viaNormalized({ nodes, weekStart: WEEK }))).status, 200);
  assert.equal((await ingest(env, '/v1/ingest/shipstation', { format: 'rows', rows: ship, weekStart: WEEK })).status, 200);
  return { env, nodes, ship };
}

