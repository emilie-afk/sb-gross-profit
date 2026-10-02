/**
 * Harness for the Free-tier tests (no tests here). End to end in one process:
 *   collector module (automation/collector/src/freeTier.mjs) → Worker /v1/collect/* → D1 stand-in
 *   → verifier (netlify/functions/gp-verify.mjs → shared/verify.js) → /v1/verify/*
 * and the SAME sources through the existing Worker path (ingest + /v1/admin/runs) as the reference.
 * The dashboard API must return the same weeks, orders, lines, breakdowns, issues and scenario lines.
 */
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { makeEnv, rnd } from './helpers.mjs';
import * as FT from '../../automation/collector/src/freeTier.mjs';
import gpVerify from '../../netlify/functions/gp-verify.mjs';
import { shopifyRows, scrRows, shipstationRows, hpdOrders, catalogCandidate } from '../../tests/fixtures-free-tier.mjs';
import { toCsvText } from '../../shared/adapters/shopifyCsv.js';
import { sanitizeShippingCostReport, parseShippingCostReport } from '../../shared/adapters/shippingCostReport.js';
import { prepareShopifyExport, rollingWindow } from '../../automation/shopify-export/src/lib.mjs';
import { addDays, stableStringify } from '../../shared/normalized.js';

export const ORIGIN = 'https://w.local';
export const bridge = env => async (url, init = {}) => worker.fetch(new Request(url, init), env);
export async function api(env, method, path, body, cls = 'admin') {
  const h = { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' };
  if (cls === 'admin') h['X-Admin-Secret'] = env.ADMIN_SECRET; else if (cls === 'ingest') h['X-Ingest-Secret'] = env.INGEST_SECRET; else if (cls === 'verify') h['X-Verify-Secret'] = env.VERIFY_SECRET;
  const r = await worker.fetch(new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* not JSON */ }
  return { status: r.status, json: j, text: t };
}
export const ok = async (p, what) => { const r = await p; assert.ok(r.status < 300, `${what}: ${r.status} ${r.text?.slice(0, 300)}`); return r.json; };
export const changes = env => env.DB.db.prepare('SELECT total_changes() AS n').get().n;

export const LAST_WEEK = '2020-03-09';                              // DST starts 2020-03-08 (in week 2020-03-02)
export function dataset({ n = 360, lastWeek = LAST_WEEK, prefix = '7', scr: scrOpts = {} } = {}) {
  const week = { weekStart: lastWeek, weekEnd: addDays(lastWeek, 6) }, win = rollingWindow(week);
  const days = (Date.parse(win.to) - Date.parse(win.from)) / 864e5 + 1;
  const { rows, meta } = shopifyRows({ n, from: win.from, days, prefix });
  const prep = prepareShopifyExport(toCsvText(rows, Object.keys(rows[0])), { week, exportedAt: `${addDays(win.to, 1)}T09:00:00Z` });
  assert.ok(!prep.refused, JSON.stringify(prep));
  const s = sanitizeShippingCostReport(scrRows(meta, { lastDay: win.to, ...scrOpts }));
  const p = parseShippingCostReport(s.rows, { requestedFrom: win.from, requestedTo: win.to });
  const scr = { format: 'csv_text', text: toCsvText(s.rows, s.columns), requestedFrom: win.from, requestedTo: win.to, rowCount: p.rowCount,
                shippingCostTotal: p.shippingCostCents / 100, exportedAt: `${addDays(win.to, 1)}T15:00:00Z` };
  const weeks = []; for (let w = win.from; w <= lastWeek; w = addDays(w, 7)) weeks.push(w);
  return { week, win, meta, shopify: prep.payload, scr, ss: shipstationRows(meta), hpd: hpdOrders(meta), catalog: catalogCandidate(), weeks };
}

export async function freeTierEnv(extra = {}) {
  return makeEnv({ VERIFY_SECRET: rnd(), AUTOMATION_ENABLED: 'false', ...extra });
}
async function common(env, d) {
  await ok(api(env, 'POST', '/v1/admin/settings', { carrier_fee_priority_locked: true, reason: 'test: priority locked' }), 'settings');
  await ok(api(env, 'POST', '/v1/ingest/catalog', d.catalog, 'ingest'), 'catalog');
  await ok(api(env, 'POST', '/v1/ingest/shipstation', { format: 'rows', rows: d.ss, weekStart: d.week.weekStart }, 'ingest'), 'shipstation');
  await ok(api(env, 'POST', '/v1/ingest/hpd', { format: 'normalized', hpdOrders: d.hpd }, 'ingest'), 'hpd');
}

/** Reference: today's Worker path. */
export async function legacyRun(d) {
  const env = await freeTierEnv();
  await common(env, d);
  await ok(api(env, 'POST', '/v1/ingest/shopify', d.shopify, 'ingest'), 'shopify');
  const up = await ok(api(env, 'POST', '/v1/ingest/shipping-cost-report', d.scr, 'ingest'), 'scr');
  if (up.status === 'pending_review') await ok(api(env, 'POST', `/v1/admin/shipping-cost/versions/${up.versionId}/accept`, { reason: 'test: reviewed' }), 'accept');
  for (const w of d.weeks) await ok(api(env, 'POST', '/v1/admin/runs', { weekStart: w, reason: 'reference' }), `compute ${w}`);
  return env;
}

/** The Free-tier path: collector uploads, collector computes, verifier verifies. */
export async function freeTierRun(d, { verify = true } = {}) {
  const env = await freeTierEnv();
  await common(env, d);
  const c = FT.collectClient({ workerUrl: ORIGIN, ingestSecret: env.INGEST_SECRET, fetchImpl: bridge(env), sleep: async () => {} });
  const meter = { start: changes(env) };
  const scr = await FT.uploadShippingCostReport(c, d.scr);
  meter.scr = changes(env) - meter.start;
  if (scr.status === 'pending_review') await ok(api(env, 'POST', `/v1/admin/scr/versions/${scr.versionId}/accept`, { reason: 'test: first version reviewed' }), 'scr accept');
  let t = changes(env);
  const orders = await FT.uploadShopifyOrders(c, d.shopify);
  meter.orders = changes(env) - t;
  const cache = FT.newCache(orders.bodies), results = [];
  t = changes(env);
  for (const w of d.weeks) results.push(await FT.computeAndUploadWeek(c, w, cache));
  meter.compute = changes(env) - t;
  const verified = [];
  if (verify) for (const r of results.filter(x => x.status === 'computed')) verified.push(await runVerifier(env, r.snapshotId));
  return { env, c, scr, orders, results, verified, meter, cache };
}

export const TRIGGER = 'trigger-secret-for-tests-0123456789abcdef';
export async function runVerifier(env, snapshotId, logs = []) {
  const res = await gpVerify(new Request('https://site.test/.netlify/functions/gp-verify', { method: 'POST', headers: { 'x-verify-trigger': TRIGGER, 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshotId }) }), { env: { SB_WORKER_ORIGIN: ORIGIN, SB_VERIFY_SECRET: env.VERIFY_SECRET, SB_VERIFY_TRIGGER_SECRET: TRIGGER }, fetchImpl: bridge(env), log: s => logs.push(s) });
  return { httpStatus: res.status, body: await res.json(), logs };
}

/** Per-environment identifiers, clock values and hashes masked; every amount and code stays. */
export const mask = v => stableStringify(v)
  .replace(/\b(scv|scr|snp|src|run|sca|crf)_[0-9a-f]{20}\b/g, 'id*').replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, 'T*').replace(/\b[0-9a-f]{64}\b/g, 'H*');
const strip = ({ computedBy: _c, verification: _v, ...r }) => r;

export async function dashboardView(env, week) {
  const q = '?includeDrafts=1';
  const snap = strip((await api(env, 'GET', `/v1/snapshot/${week}${q}`)).json);
  const lists = {};
  for (const sort of ['gp_asc', 'gp_desc', 'revenue_desc', 'date_desc', 'date_asc']) lists[sort] = await allPages(env, `/v1/snapshot/${week}/orders${q}&sort=${sort}`);
  lists.missingCost = await allPages(env, `/v1/snapshot/${week}/orders${q}&missingCost=true`);
  lists.page2 = strip((await api(env, 'GET', `/v1/snapshot/${week}/orders${q}&limit=25&offset=25`)).json);
  const names = lists.gp_asc.orders.map(o => o.orderName);
  const details = [];
  for (const n of [names[0], names[Math.floor(names.length / 2)], names[names.length - 1]]) details.push(strip((await api(env, 'GET', `/v1/snapshot/${week}/orders/${encodeURIComponent(n)}${q}`)).json));
  const issues = strip((await api(env, 'GET', `/v1/snapshot/${week}/issues${q}&limit=1000`)).json);
  const scenario = await allScenario(env, `/v1/snapshot/${week}/scenario-input${q}`);
  return { snap, lists, details, issues, scenario };
}
/** Every page of an order list (pages of 100), joined: the page block becomes { total }. */
export async function allPages(env, path) {
  let first = null, orders = [];
  for (let offset = 0; ; offset += 100) {
    const r = strip((await api(env, 'GET', `${path}&limit=100&offset=${offset}`)).json);
    first ||= r; orders = orders.concat(r.orders);
    if (offset + 100 >= r.page.total) break;
  }
  return { ...first, page: { total: first.page.total }, orders };
}
/** Every scenario-input page, joined. */
export async function allScenario(env, path) {
  const first = strip((await api(env, 'GET', `${path}&page=0`)).json);
  let lines = first.lines;
  for (let p = 1; p < first.page.count; p++) lines = lines.concat((await api(env, 'GET', `${path}&page=${p}`)).json.lines);
  const { page, ...rest } = first;
  return { ...rest, pages: page.count, lines };
}


export const client = env => FT.collectClient({ workerUrl: ORIGIN, ingestSecret: env.INGEST_SECRET, fetchImpl: bridge(env), sleep: async () => {} });

/** A sanitized Shipping Cost Report upload body from raw (18-column) synthetic rows. */
export function scrPayload(rawRows, from, to, exportedAt = `${addDays(to, 1)}T15:00:00Z`) {
  const s = sanitizeShippingCostReport(rawRows);
  const p = parseShippingCostReport(s.rows, { requestedFrom: from, requestedTo: to });
  return { format: 'csv_text', text: toCsvText(s.rows, s.columns), requestedFrom: from, requestedTo: to, rowCount: p.rowCount,
           shippingCostTotal: p.shippingCostCents / 100, exportedAt };
}
