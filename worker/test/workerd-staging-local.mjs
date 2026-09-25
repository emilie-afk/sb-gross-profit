/**
 * C8 local staging rehearsal (workerd + real local D1 via Miniflare).
 *
 *   cd worker && npm run staging-local
 *
 * NOT a substitute for the real staging Worker: it runs the same bundle and
 * migrations 0001–0011 in Cloudflare's runtime on this machine, with two
 * separate local D1 databases standing in for production and staging. It
 * reports, with synthetic data only:
 *   1. tools/staging-acceptance.mjs against the local "staging" Worker, with the
 *      local "production" Worker as the read-only isolation check;
 *   2. a staging Worker pointed at the production-bound D1 → every request refused;
 *   3. capacity: a ~3,000-order rolling Shopify export (sanitized by the
 *      collector's own code), a ~3,300-row Shipping Cost Report, computes,
 *      duplicate uploads and touched-week revisions — durations and row counts.
 * Local timings are indicative only; Cloudflare CPU / memory limits are not
 * enforced by Miniflare and must be measured on the real staging Worker.
 */
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { hashPassword } = await import(REPO + '/worker/src/auth.js');
const { runStagingAcceptance } = await import(REPO + '/tools/staging-acceptance.mjs');
const { csvOrder } = await import(REPO + '/tests/fixtures-normalized.mjs');
const { reportRow } = await import(REPO + '/tests/fixtures-shipping-cost.mjs');
const { sanitizeShippingCostReport, parseShippingCostReport } = await import(REPO + '/shared/adapters/shippingCostReport.js');
const { toCsvText } = await import(REPO + '/shared/adapters/shopifyCsv.js');
const { prepareShopifyExport, rollingWindow } = await import(REPO + '/automation/shopify-export/src/lib.mjs');
const { catalog } = await import(REPO + '/worker/test/helpers.mjs');
const { addDays } = await import(REPO + '/shared/normalized.js');

const rnd = () => crypto.randomUUID() + crypto.randomUUID();
const out = [];
const log = (...a) => { const s = a.join(' '); out.push(s); console.log(s); };
const ms = t0 => Math.round(performance.now() - t0);
const bundle = (await build({ entryPoints: [path.join(REPO, 'worker/src/index.js')], bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', write: false })).outputFiles[0].text;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-c8-'));
const MIGRATIONS = fs.readdirSync(REPO + '/worker/migrations').filter(f => f.endsWith('.sql')).sort();

async function instance(name, { environment, persist, automation = 'false', migrate = true }) {
  const S = { INGEST_SECRET: rnd(), ADMIN_SECRET: rnd(), SESSION_SIGNING_KEY: rnd() };
  const password = 'synthetic-' + crypto.randomUUID();
  const mf = new Miniflare({ modules: true, script: bundle, compatibilityDate: '2024-09-01', d1Databases: ['DB'], d1Persist: persist,
    bindings: { ...S, DASHBOARD_PASSWORD_HASH: await hashPassword(password, { iterations: 1000 }), ALLOWED_ORIGINS: 'https://sb-profit.netlify.app',
                COOKIE_SAMESITE: 'Strict', PUBLICATION_ALLOWED: 'false', AUTOMATION_ENABLED: automation, D1_QUOTA_BYTES: '5000000000', SB_ENVIRONMENT: environment } });
  const db = await mf.getD1Database('DB');
  if (migrate) for (const f of MIGRATIONS) {
    const sql = fs.readFileSync(path.join(REPO, 'worker/migrations', f), 'utf8').split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
    await db.batch(sql.split(/;\s*\n/).map(x => x.trim()).filter(Boolean).map(x => db.prepare(x)));
  }
  const base = `https://${name}.local`;
  const fetchImpl = (url, init) => mf.dispatchFetch(url, init);
  const call = async (method, p, { body, headers = {} } = {}) => {
    const r = await fetchImpl(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ }
    return { status: r.status, json: j, bytes: t.length };
  };
  const A = { 'X-Admin-Secret': S.ADMIN_SECRET }, I = { 'X-Ingest-Secret': S.INGEST_SECRET };
  const count = async t => (await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first()).n;
  return { mf, db, S, password, base, fetchImpl, call, A, I, count };
}

// ── 0. Migrations ─────────────────────────────────────────────────────────────
const prod = await instance('prod', { environment: 'production', persist: path.join(tmp, 'prod') });
const stg = await instance('staging', { environment: 'staging', persist: path.join(tmp, 'staging') });
const tables = (await stg.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).results.map(r => r.name);
const cycleCols = (await stg.db.prepare('PRAGMA table_info(schedule_cycle)').all()).results.map(r => r.name);
assert.equal(MIGRATIONS.length, 11); assert.equal(MIGRATIONS.at(-1), '0011_c7_orchestration.sql');
assert.ok(['automation_lease', 'automation_event', 'shipping_cost_source_version'].every(t => tables.includes(t)));
assert.ok(['status', 'missing', 'sources_changed_at', 'changes_seen_at'].every(c => cycleCols.includes(c)));
log(`PASS    M1 migrations 0001–0011 applied to separate local D1s (${MIGRATIONS.length} files, ${tables.length} tables)`);

// ── 1. Acceptance script against local staging, local production read-only ───
assert.equal((await prod.call('POST', '/v1/admin/environment/bind', { headers: prod.A, body: { environment: 'production', reason: 'local rehearsal: bind production D1' } })).status, 200);
const prodBefore = await Promise.all(['ingest_run', 'shipping_cost_source_version', 'settings_audit', 'reporting_run'].map(prod.count));
const acc = await runStagingAcceptance({ base: stg.base, adminSecret: stg.S.ADMIN_SECRET, ingestSecret: stg.S.INGEST_SECRET, password: stg.password,
  prod: { base: prod.base, adminSecret: prod.S.ADMIN_SECRET }, bind: true, fetchImpl: (u, i) => (u.startsWith(prod.base) ? prod : stg).fetchImpl(u, i), log: s => log(s) });
assert.ok(acc.every(r => r.status === 'PASS'), 'local acceptance');
const prodAfter = await Promise.all(['ingest_run', 'shipping_cost_source_version', 'settings_audit', 'reporting_run'].map(prod.count));
assert.deepEqual(prodAfter, prodBefore);
log(`PASS    M2 production D1 row counts unchanged by the staging run (${prodAfter.join('/')})`);

// ── 2. Staging Worker pointed at the production-bound D1 ──────────────────────
await prod.mf.dispose();
const wrong = await instance('wrong', { environment: 'staging', persist: path.join(tmp, 'prod'), migrate: false, automation: 'true' });
const codes = [];
for (const [m, p, h, b] of [['GET', '/v1/admin/settings', wrong.A], ['POST', '/v1/admin/settings', wrong.A, { publication_enabled: true, reason: 'must not land' }],
  ['POST', '/v1/ingest/catalog', wrong.I, catalog()], ['POST', '/v1/admin/runs', wrong.A, { weekStart: '2026-09-14' }], ['GET', '/v1/weeks', {}]]) {
  const r = await wrong.call(m, p, { headers: h, body: b }); codes.push(`${r.status}:${r.json?.error}`);
}
const tick = await (await wrong.mf.getWorker()).scheduled({ scheduledTime: new Date() });
const afterWrong = await Promise.all(['ingest_run', 'shipping_cost_source_version', 'settings_audit', 'reporting_run'].map(wrong.count));
assert.ok(codes.slice(0, 4).every(c => c === '503:database_environment_mismatch'), codes.join(' '));
assert.deepEqual(afterWrong, prodBefore);
log(`PASS    M3 staging Worker on the production-bound D1: ${codes.join(' ')}; cron tick ${JSON.stringify(tick?.outcome || 'ran')}; rows unchanged`);
await wrong.mf.dispose();

// ── 3. Capacity with a ~3,000-order rolling upload ────────────────────────────
const W = '2026-09-14', week = { weekStart: W, weekEnd: '2026-09-20' };
const win = rollingWindow(week);
const N = 3000, days = 56;
const SKUS = ['MG-ALOE', 'MG-JADE', 'FH-POTHOS', 'LIV-1', 'CAL-7', 'NOPE-9'];
const orderRows = [];
for (let i = 0; i < N; i++) {
  const day = addDays(win.from, Math.floor((i * days) / N));
  const lines = Array.from({ length: 1 + (i % 3) }, (_, k) => ({ sku: SKUS[(i + k) % SKUS.length], price: 8 + ((i + k) % 5), qty: 1 + (k % 2), vendor: k % 2 ? 'Live to Give' : 'Succulents Box' }));
  const sub = lines.reduce((s, l) => s + l.price * l.qty, 0);
  orderRows.push(...csvOrder({ name: `#7${String(i).padStart(5, '0')}`, createdAt: `${day} 10:${String(i % 60).padStart(2, '0')}:00 -0700`, subtotal: sub, shipping: 5, total: sub + 5,
                               refunded: i % 97 === 0 ? 3 : 0, lines }).map(r => ({ ...r, 'Fulfilled at': '' })));
}
const rawText = toCsvText(orderRows, Object.keys(orderRows[0]));
let t0 = performance.now();
const prep = prepareShopifyExport(rawText, { week, exportedAt: '2026-09-21T09:00:00Z' });
assert.ok(!prep.refused, JSON.stringify(prep));
const prepMs = ms(t0);
const reportRaw = [];
for (let i = 0; i < N; i++) {
  const ship = addDays(win.from, Math.min(days - 1, Math.floor((i * days) / N) + 1));
  const us = `${ship.slice(5, 7)}/${ship.slice(8, 10)}/${ship.slice(0, 4)}`;
  reportRaw.push(reportRow({ date: us, order: `7${String(i).padStart(5, '0')}`, cost: (4 + (i % 7) * 0.5).toFixed(2), paid: '5.00' }));
  if (i % 10 === 0) reportRaw.push(reportRow({ date: us, order: `7${String(i).padStart(5, '0')}`, cost: '1.25', paid: '0.00' }));   // multi-row order
}
const sRep = sanitizeShippingCostReport(reportRaw);
const pRep = parseShippingCostReport(sRep.rows, { requestedFrom: win.from, requestedTo: win.to });
const repBody = { format: 'csv_text', text: toCsvText(sRep.rows, sRep.columns), requestedFrom: win.from, requestedTo: win.to, rowCount: pRep.rowCount,
                  shippingCostTotal: pRep.shippingCostCents / 100, exportedAt: '2026-09-21T15:00:00Z' };
assert.ok(!sRep.columns.includes('Recipient') && !sRep.columns.includes('Shipping Paid') && !sRep.columns.includes('+/-'));

assert.equal((await stg.call('POST', '/v1/admin/settings', { headers: stg.A, body: { carrier_fee_priority_locked: true, reason: 'local rehearsal only' } })).status, 200);
assert.equal((await stg.call('POST', '/v1/ingest/catalog', { headers: stg.I, body: catalog() })).status, 200);
const rowsBefore = await stg.count('shopify_order_line');
t0 = performance.now();
const up = await stg.call('POST', '/v1/ingest/shopify', { headers: stg.I, body: prep.payload });
const upMs = ms(t0);
assert.equal(up.status, 200, JSON.stringify(up.json).slice(0, 300));
t0 = performance.now();
const dup = await stg.call('POST', '/v1/ingest/shopify', { headers: stg.I, body: prep.payload });
const dupMs = ms(t0);
t0 = performance.now();
const rep = await stg.call('POST', '/v1/ingest/shipping-cost-report', { headers: stg.I, body: repBody });
const repMs = ms(t0);
assert.equal(rep.status, 200, JSON.stringify(rep.json).slice(0, 300));
const repDup = await stg.call('POST', '/v1/ingest/shipping-cost-report', { headers: stg.I, body: repBody });
t0 = performance.now();
const accRes = await stg.call('POST', `/v1/admin/shipping-cost/versions/${rep.json.versionId}/accept`, { headers: stg.A, body: { reason: 'local rehearsal only' } });
const accMs = ms(t0);
assert.equal(accRes.status, 200);
const weeks = []; for (let w = addDays(W, -49); w <= W; w = addDays(w, 7)) weeks.push(w);
const computeMs = [];
for (const w of weeks) {
  t0 = performance.now();
  const r = await stg.call('POST', '/v1/admin/runs', { headers: stg.A, body: { weekStart: w } });
  computeMs.push(ms(t0));
  assert.equal(r.status, 200, `${w}: ${JSON.stringify(r.json).slice(0, 200)}`);
}
// A second rolling export: refunds on some older orders → touched earlier weeks → draft revisions.
const changed = orderRows.map(r => (/^#7\d{3}[05]0$/.test(r.Name) && r['Refunded Amount'] !== '' ? { ...r, 'Refunded Amount': '2' } : r));
const prep2 = prepareShopifyExport(toCsvText(changed, Object.keys(changed[0])), { week, exportedAt: '2026-09-21T10:00:00Z' });
t0 = performance.now();
const up2 = await stg.call('POST', '/v1/ingest/shopify', { headers: stg.I, body: prep2.payload });
const up2Ms = ms(t0);
t0 = performance.now();
const rt = await stg.call('POST', '/v1/admin/revise-touched', { headers: stg.A, body: { weekStart: W, maxWeeks: 8 } });
const rtMs = ms(t0);
const storage = await stg.call('GET', '/v1/admin/storage', { headers: stg.A });
const counts = Object.fromEntries(await Promise.all(['shopify_order', 'shopify_order_line', 'shipping_cost_row', 'snapshot', 'snapshot_order', 'snapshot_line'].map(async t => [t, await stg.count(t)])));
log(`INFO    C1 rolling export ${N} orders / ${orderRows.length} line rows / ${prep.payload.text.length} bytes sanitized (collector prep ${prepMs} ms)`);
log(`PASS    C2 rolling upload ${upMs} ms → ${up.json.sourceStatus}; weeks ${Object.keys(up.json.weeksTouched || {}).length} touched; line rows +${counts.shopify_order_line - rowsBefore}`);
log(`${dup.json?.sourceStatus === 'source_no_change' ? 'PASS' : 'FAIL'}    C3 duplicate rolling upload ${dupMs} ms → ${dup.json?.sourceStatus}`);
log(`PASS    C4 Shipping Cost Report ${pRep.rowCount} rows (${pRep.rowCount - N} multi-row extras) ${repMs} ms → ${rep.json.status}; duplicate → ${repDup.json?.sourceStatus}; accept ${accMs} ms`);
log(`PASS    C5 ${weeks.length} weekly computes: ${computeMs.join(', ')} ms (max ${Math.max(...computeMs)})`);
log(`${up2.status === 200 && rt.status === 200 ? 'PASS' : 'FAIL'}    C6 changed rolling upload ${up2Ms} ms (${Object.keys(up2.json?.weeksTouched || {}).length} weeks touched); revise-touched ${rtMs} ms → ${rt.json?.revised?.length ?? 0} draft revisions, ${rt.json?.revised?.filter(x => x.error).length ?? 0} errors`);
log(`INFO    C7 D1 rows: ${JSON.stringify(counts)}; storage ${storage.json.bytesUsed} bytes (${storage.json.pctOfQuota}% of 5 GB)`);
await stg.mf.dispose();
fs.rmSync(tmp, { recursive: true, force: true });
log('LOCAL STAGING REHEARSAL: PASS (local workerd + local D1; not the real staging Worker)');
