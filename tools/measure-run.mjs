#!/usr/bin/env node
/**
 * measure-run.mjs — D1 rows read / written by whole collector runs, measured by the Worker's own meter
 * =====================================================================================================
 *   node tools/measure-run.mjs [--orders-per-window 3300] [--history-windows 3]
 *
 * Runs the bundled Worker in workerd (Miniflare) with a local D1 database, all migrations applied, and
 * drives it with the real collector (freeTierPipeline + runWeeklyCollection with faked browsers) and
 * the real verifier (gp-verify-background). Each scenario's rows read and written come from the
 * Worker's d1_usage meter (worker/src/usage.js: the sum of every statement's meta.rows_read /
 * rows_written as workerd's D1 reports them, the figures D1 bills). Local only: no Cloudflare account.
 *
 * Limitations: synthetic data (order and report shapes from tests/fixtures-free-tier.mjs); local D1
 * counts rows the way SQLite does, which is what D1 reports, but production totals also include what
 * this meter cannot see (staging, console, REST API, migrations, the meter's own upserts).
 * Prints aggregates only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const N = arg('--orders-per-window', 3300), HISTORY = arg('--history-windows', 3);
const imp = p => import(pathToFileURL(path.join(ROOT, p)).href);
const { Miniflare } = await import(pathToFileURL(path.join(ROOT, 'worker/node_modules/miniflare/dist/src/index.js')).href);
const { dataset, ORIGIN, TRIGGER } = await imp('worker/test/freeTierHarness.mjs');
const FT = await imp('automation/collector/src/freeTier.mjs');
const { runWeeklyCollection } = await imp('automation/collector/src/orchestrate.mjs');
const { hashPassword } = await imp('worker/src/auth.js');
const { catalog } = await imp('worker/test/helpers.mjs');
const gpVerify = (await imp('netlify/functions/gp-verify-background.mjs')).default;
const { addDays } = await imp('shared/normalized.js');

// Bundle the Worker as wrangler deploys it, and apply every migration to a fresh local D1.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-run-'));
const W = path.join(ROOT, 'worker/node_modules/.bin/wrangler');
execFileSync(W, ['deploy', '--dry-run', '--outdir', path.join(dir, 'bundle')], { cwd: path.join(ROOT, 'worker'), stdio: 'ignore', env: { ...process.env, CI: 'true' } });
fs.mkdirSync(path.join(dir, 'migrations'));
for (const f of fs.readdirSync(path.join(ROOT, 'worker/migrations'))) fs.copyFileSync(path.join(ROOT, 'worker/migrations', f), path.join(dir, 'migrations', f));
fs.writeFileSync(path.join(dir, 'wrangler.toml'), 'name = "m"\nmain = "w.js"\ncompatibility_date = "2026-01-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "m"\ndatabase_id = "00000000-0000-0000-0000-000000000000"\nmigrations_dir = "migrations"\n');
fs.writeFileSync(path.join(dir, 'w.js'), 'export default { fetch() { return new Response("x") } }');
execFileSync(W, ['d1', 'migrations', 'apply', 'm', '--local'], { cwd: dir, env: { ...process.env, CI: 'true' }, stdio: 'ignore' });

const rnd = () => crypto.randomUUID() + crypto.randomUUID();
const PASSWORD = rnd();
const secrets = { INGEST_SECRET: rnd(), ADMIN_SECRET: rnd(), SESSION_SIGNING_KEY: rnd(), VERIFY_SECRET: rnd(),
                  DASHBOARD_PASSWORD_HASH: await hashPassword(PASSWORD, { iterations: 1000 }) };
const mf = new Miniflare({
  modules: true, script: fs.readFileSync(path.join(dir, 'bundle', 'index.js'), 'utf8'), compatibilityDate: '2026-09-01',
  d1Databases: { DB: '00000000-0000-0000-0000-000000000000' }, d1Persist: path.join(dir, '.wrangler/state/v3/d1'),
  bindings: { ...secrets, ALLOWED_ORIGINS: 'https://sb-profit.netlify.app', COOKIE_SAMESITE: 'Strict', PUBLICATION_ALLOWED: 'false',
              AUTOMATION_ENABLED: 'false', REPORTING_START_DATE: '2019-01-01' },
});
let db = await mf.getD1Database('DB');
const toWorker = async (url, init = {}) => {
  const r = await mf.dispatchFetch(url, { method: init.method || 'GET', headers: init.headers, body: init.body });
  return new Response(await r.arrayBuffer(), { status: r.status, headers: r.headers });
};
const verifyEnv = { SB_WORKER_ORIGIN: ORIGIN, SB_VERIFY_SECRET: secrets.VERIFY_SECRET, SB_VERIFY_TRIGGER_SECRET: TRIGGER };
const fetchImpl = (url, init) => url.startsWith('https://site.test/')
  ? gpVerify(new Request(url, init), { env: verifyEnv, fetchImpl: toWorker, log: () => {} }) : toWorker(url, init);
const call = async (method, p, body, cls = 'admin', headers = {}) => {
  const h = { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9', ...headers };
  if (cls === 'admin') h['X-Admin-Secret'] = secrets.ADMIN_SECRET; else if (cls === 'ingest') h['X-Ingest-Secret'] = secrets.INGEST_SECRET;
  const r = await toWorker(ORIGIN + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* not JSON */ }
  if (r.status >= 300 && cls !== 'none') throw new Error(`${method} ${p}: ${r.status} ${t.slice(0, 200)}`);
  return { status: r.status, json: j, headers: r.headers };
};

const usage = async () => Object.fromEntries(((await db.prepare('SELECT scope, rows_read, rows_written, requests FROM d1_usage').all()).results || [])
  .map(r => [r.scope, { read: r.rows_read, written: r.rows_written, requests: r.requests }]));
const diff = (a, b) => Object.fromEntries(['background', 'dashboard'].map(s => [s, { read: (b[s]?.read || 0) - (a[s]?.read || 0), written: (b[s]?.written || 0) - (a[s]?.written || 0), requests: (b[s]?.requests || 0) - (a[s]?.requests || 0) }]));
const results = {};
async function measure(name, fn) {
  const a = await usage(), t0 = Date.now();
  const out = await fn();
  results[name] = { ...diff(a, await usage()), seconds: Math.round((Date.now() - t0) / 100) / 10, ...(out ? { outcome: out } : {}) };
}

// Setup: controls, catalog, automatic report acceptance.
await call('POST', '/v1/admin/settings', { carrier_fee_priority_locked: true, reason: 'measure: priority locked' });
await call('POST', '/v1/ingest/catalog', catalog(), 'ingest');
for (const [k, v] of [['shipping_cost_auto_accept_enabled', true], ['shipping_cost_auto_accept_rules', 'flag_and_accept']]) await call('POST', '/v1/admin/settings', { [k]: v, reason: `measure: ${k}` });

// History: earlier eight-week windows uploaded (not computed), oldest first, so the tables have production-like sizes.
const d = dataset({ n: N, scr: { zeroEvery: 1e9 } });
const client = FT.collectClient({ workerUrl: ORIGIN, ingestSecret: secrets.INGEST_SECRET, fetchImpl, sleep: async () => {} });
await measure('history_upload', async () => {
  for (let h = HISTORY; h >= 1; h--) {
    const old = dataset({ n: N, lastWeek: addDays(d.week.weekStart, -56 * h), prefix: String(7 - h), scr: { zeroEvery: 1e9 } });
    await FT.uploadShippingCostReport(client, old.scr);
    await FT.uploadShopifyOrders(client, old.shopify);
  }
});

// The history stands for earlier days: start today's budget from zero (as after a 00:00 UTC reset).
await db.prepare('DELETE FROM d1_usage').run();

const mk = (closedWeek = d.week.weekStart) => FT.freeTierPipeline({ workerUrl: ORIGIN, ingestSecret: secrets.INGEST_SECRET, closedWeek, fetchImpl,
  verifyUrl: 'https://site.test/.netlify/functions/gp-verify-background', triggerSecret: TRIGGER, sleep: async () => {} });
const stateDir = fs.mkdtempSync(path.join(dir, 'state-'));
const runOnce = (src = d, ft = mk(), plan = null) => runWeeklyCollection({
  week: { weekStart: d.week.weekStart, weekEnd: d.week.weekEnd, closed: true },
  lockFile: path.join(stateDir, 'lock'), stateFile: path.join(stateDir, `state-${Math.random()}.json`),
  weekPlan: () => (plan ? plan() : ft.weekPlan()), budget: () => ft.budget(),
  shipstation: { collect: async () => ({ status: 'prepared', exitCode: 0, pending: { payload: src.scr } }),
                 upload: async p => { const r = await ft.uploadImpl({ path: '/v1/ingest/shipping-cost-report', payload: p.payload }); return { status: r.ok ? 'ok' : 'upload_failed', exitCode: r.ok ? 0 : 31 }; } },
  shopify: { run: async ({ onWaiting }) => { await onWaiting(); const r = await ft.uploadImpl({ path: '/v1/ingest/shopify', payload: src.shopify }); return { status: r.ok ? 'ok' : 'upload_failed', exitCode: r.ok ? 0 : 32 }; } },
  compute: () => ft.compute(),
});
const short = r => ({ status: r.status, exitCode: r.exitCode, weeks: r.compute?.weeks?.length, computed: r.compute?.weeks?.filter(w => w.status === 'computed').length,
                      notOk: (r.compute?.weeks || []).filter(w => !['computed', 'unchanged'].includes(w.status) || (w.verification && w.verification !== 'verified')).map(w => `${w.weekStart}:${w.status}:${w.code || w.verification || ''}`),
                      published: r.compute?.publication?.filter(p => p.published && !p.alreadyPublished).length });

// 1. The previous Monday (first load of the window then: 7 weeks of data), then a normal Monday: the rolling
//    exports again (7 weeks unchanged, 1 new week), the new week computed and verified (publication off).
const { shopifyRows, scrRows: scrRows0 } = await imp('tests/fixtures-free-tier.mjs');
const { toCsvText: csv0 } = await imp('shared/adapters/shopifyCsv.js');
const { sanitizeShippingCostReport: san0, parseShippingCostReport: parse0 } = await imp('shared/adapters/shippingCostReport.js');
const { prepareShopifyExport, rollingWindow } = await imp('automation/shopify-export/src/lib.mjs');
const cut = d.weeks[7], prevWeek = { weekStart: d.weeks[6], weekEnd: addDays(d.weeks[6], 6) }, prevWin = rollingWindow(prevWeek);
const winDays = (Date.parse(d.win.to) - Date.parse(d.win.from)) / 864e5 + 1;
const all = shopifyRows({ n: N, from: d.win.from, days: winDays, prefix: '7' });
const keep = new Set(all.meta.filter(o => o.day < cut).map(o => o.name));
const prevRows = all.rows.filter(r => keep.has(r.Name));
const prevShop = prepareShopifyExport(csv0(prevRows, Object.keys(prevRows[0])), { week: prevWeek, exportedAt: `${cut}T09:00:00Z` }).payload;
const prevSr = san0(scrRows0(all.meta.filter(o => o.day < cut), { lastDay: addDays(cut, -1), zeroEvery: 1e9 }));
const prevPr = parse0(prevSr.rows, { requestedFrom: prevWin.from, requestedTo: addDays(cut, -1) });
const prev = { week: prevWeek, shopify: prevShop, scr: { format: 'csv_text', text: csv0(prevSr.rows, prevSr.columns), requestedFrom: prevWin.from, requestedTo: addDays(cut, -1),
  rowCount: prevPr.rowCount, shippingCostTotal: prevPr.shippingCostCents / 100, exportedAt: `${cut}T15:00:00Z` } };
const runFor = (src, ft) => runWeeklyCollection({
  week: { weekStart: src.week.weekStart, weekEnd: src.week.weekEnd, closed: true },
  lockFile: path.join(stateDir, 'lock'), stateFile: path.join(stateDir, `state-${Math.random()}.json`),
  weekPlan: () => ft.weekPlan(), budget: () => ft.budget(),
  shipstation: { collect: async () => ({ status: 'prepared', exitCode: 0, pending: { payload: src.scr } }),
                 upload: async p => { const r = await ft.uploadImpl({ path: '/v1/ingest/shipping-cost-report', payload: p.payload }); return { status: r.ok ? 'ok' : 'upload_failed', exitCode: r.ok ? 0 : 31 }; } },
  shopify: { run: async ({ onWaiting }) => { await onWaiting(); const r = await ft.uploadImpl({ path: '/v1/ingest/shopify', payload: src.shopify }); return { status: r.ok ? 'ok' : 'upload_failed', exitCode: r.ok ? 0 : 32 }; } },
  compute: () => ft.compute(),
});
await measure('previous_monday_first_load', async () => short(await runFor(prev, mk(prevWeek.weekStart))));
await measure('normal_monday_new_week', async () => short(await runOnce()));
// 2. A retry with nothing new (what each of up to six partial-run retries costs), with rows read per route.
const byRoute = {};
const total = async () => { const u = await usage(); return (u.background?.read || 0) + (u.dashboard?.read || 0); };
const routed = ft => { const f0 = fetchImpl; return async (url, init) => {
  const before = await total(); const r = await f0(url, init);
  const key = (init?.method || 'GET') + ' ' + new URL(url).pathname.replace(/\d{4}-\d{2}-\d{2}/, ':week').replace(/snp_[0-9a-f]+/, ':snp').replace(/src_[0-9a-f]+/, ':src');
  const e = byRoute[key] ??= { calls: 0, read: 0 }; e.calls++; e.read += (await total()) - before; return r; }; };
await measure('retry_nothing_new', async () => short(await runOnce(d, FT.freeTierPipeline({ workerUrl: ORIGIN, ingestSecret: secrets.INGEST_SECRET, closedWeek: d.week.weekStart,
  fetchImpl: routed(), verifyUrl: 'https://site.test/.netlify/functions/gp-verify-background', triggerSecret: TRIGGER, sleep: async () => {} }))));
results.retry_nothing_new.byRoute = Object.fromEntries(Object.entries(byRoute).sort((a, b) => b[1].read - a[1].read));
// 2b. A second retry: no input written since the first, so the unchanged-week checks answer (migration 0021).
await measure('second_retry_nothing_new', async () => short(await runOnce()));
// 3. Verification recovery: three drafts lost their verification; one run recovers them.
await db.prepare("DELETE FROM verify_report WHERE snapshot_id IN (SELECT snapshot_id FROM snapshot ORDER BY week_start LIMIT 3)").run();
await measure('verification_recovery_3_weeks', async () => short(await runOnce()));
// 4. Publication switched on: every week published oldest first, comparisons brought up to date in the run.
for (const w of d.weeks) {
  const rev = (await db.prepare('SELECT catalog_rev FROM snapshot WHERE week_start = ?1 ORDER BY revision DESC LIMIT 1').bind(w).first())?.catalog_rev;
  if (!rev) { console.error(JSON.stringify(results)); throw new Error(`no snapshot for ${w}`); }
  await call('POST', `/v1/admin/weeks/${w}/accept-pinned-catalog`, { catalogRev: rev, reason: 'measure: pinned catalog is right for this period' });
}
for (const [k, v] of [['provisional_publication_enabled', true], ['publication_enabled', true], ['ss_coverage_threshold', 0.5]]) await call('POST', '/v1/admin/settings', { [k]: v, reason: `measure: ${k}` });
await mf.setOptions({ modules: true, script: fs.readFileSync(path.join(dir, 'bundle', 'index.js'), 'utf8'), compatibilityDate: '2026-09-01',
  d1Databases: { DB: '00000000-0000-0000-0000-000000000000' }, d1Persist: path.join(dir, '.wrangler/state/v3/d1'),
  bindings: { ...secrets, ALLOWED_ORIGINS: 'https://sb-profit.netlify.app', COOKIE_SAMESITE: 'Strict', PUBLICATION_ALLOWED: 'true',
              AUTOMATION_ENABLED: 'false', REPORTING_START_DATE: '2019-01-01' } });
db = await mf.getD1Database('DB');
await measure('publish_all_weeks_with_comparisons', async () => short(await runOnce()));
// 5. A later report restates the first week's costs: that week and every dependent comparison in one run.
const { scrRows } = await imp('tests/fixtures-free-tier.mjs');
const { toCsvText } = await imp('shared/adapters/shopifyCsv.js');
const { sanitizeShippingCostReport, parseShippingCostReport } = await imp('shared/adapters/shippingCostReport.js');
const w0 = d.weeks[0], last0 = addDays(w0, 6);
const sr = sanitizeShippingCostReport(scrRows(d.meta.filter(o => o.day >= w0 && o.day <= last0), { lastDay: last0, costShift: 0.25, zeroEvery: 1e9, extraUnmatched: 0 }));
const pr = parseShippingCostReport(sr.rows, { requestedFrom: w0, requestedTo: last0 });
const restated = { ...d, scr: { format: 'csv_text', text: toCsvText(sr.rows, sr.columns), requestedFrom: w0, requestedTo: last0, rowCount: pr.rowCount,
                                shippingCostTotal: pr.shippingCostCents / 100, exportedAt: `${addDays(d.win.to, 2)}T15:00:00Z` } };
await measure('restatement_and_dependent_comparisons', async () => short(await runOnce(restated, mk(), async () => ({ collected: {} }))));
await measure('retry_after_publication', async () => short(await runOnce()));
// 5b. The daily recovery check of a week that is done: one request, nothing unfinished.
await measure('daily_check_nothing_unfinished', async () => { const w = await mk().work(); return { unfinished: w.unfinished, budget: w.budget.state }; });
// 6. Dashboard: sign in, list weeks, open one week, one orders page and one order (one person, one visit).
await measure('dashboard_visit', async () => {
  const login = await call('POST', '/v1/auth/login', { password: PASSWORD }, 'none', { Origin: 'https://sb-profit.netlify.app' });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const get = p => call('GET', p, undefined, 'none', { Cookie: cookie });
  const weeks = (await get('/v1/weeks')).json?.weeks || [];
  const w = weeks[0]?.weekStart;
  const page = (await get(`/v1/snapshot/${w}/orders?offset=0&limit=100&sort=date_asc`)).json;
  await get(`/v1/snapshot/${w}`);
  const first = page?.orders?.[0]?.orderName;
  if (first) await get(`/v1/snapshot/${w}/orders/${encodeURIComponent(first)}`);
  return { login: login.status, weeks: weeks.length };
});
// The meter's own upsert (not in its sums): its rows read / written as D1 reports them, first insert and update.
const up = sql => db.prepare(`INSERT INTO d1_usage (day, scope, rows_read, rows_written, requests) VALUES ('2000-01-01', 'probe', 1, 1, 1)
  ON CONFLICT(day, scope) DO UPDATE SET rows_read = rows_read + excluded.rows_read, rows_written = rows_written + excluded.rows_written, requests = requests + 1`).run();
const m1 = (await up()).meta, m2 = (await up()).meta;
const meterCost = { insert: { read: m1.rows_read, written: m1.rows_written }, update: { read: m2.rows_read, written: m2.rows_written } };
for (const r of Object.values(results)) for (const sc of ['background', 'dashboard']) {
  if (!r[sc]) continue;
  r[sc].meterOverhead = { read: r[sc].requests * m2.rows_read, written: r[sc].requests * m2.rows_written };
  r[sc].totalWithMeter = { read: r[sc].read + r[sc].meterOverhead.read, written: r[sc].written + r[sc].meterOverhead.written };
}
const orders = (await db.prepare('SELECT COUNT(*) AS n FROM ord_ptr').first()).n;
const days = (await db.prepare('SELECT COUNT(*) AS n FROM scr_day').first()).n;
console.log(JSON.stringify({ history: { orders, storedReportDays: days, ordersPerWindow: N, windows: HISTORY + 1 }, meterCost, rows: results }, null, 1));
await mf.dispose();
fs.rmSync(dir, { recursive: true, force: true });
