#!/usr/bin/env node
/**
 * C8 staging acceptance — run against the STAGING Worker (never production).
 *
 *   SB_STAGING_URL=https://sb-gp-worker-staging.<account>.workers.dev \
 *   SB_STAGING_ADMIN_SECRET=… SB_STAGING_INGEST_SECRET=… SB_STAGING_DASHBOARD_PASSWORD=… \
 *   [SB_PROD_URL=… SB_PROD_ADMIN_SECRET=…]   # optional, READ-ONLY isolation check
 *   node tools/staging-acceptance.mjs [--bind]
 *
 * Prints one line per check: PASS / FAIL / NOT RUN, with codes and counts only
 * (no secret, cookie, row, customer datum or sheet address). Writes to staging
 * are limited to: the one-time environment bind (--bind), and one SYNTHETIC
 * Shipping Cost Report for a 2020 week, uploaded twice (idempotency) and then
 * rejected so it stays financially inert. Production is only ever read.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SHIPPING_COST_REPORT_COLUMNS } from '../shared/adapters/shippingCostReport.js';
import { toCsvText } from '../shared/adapters/shopifyCsv.js';

const SYN_FROM = '2020-01-06', SYN_TO = '2020-01-12';
const synReport = () => {
  const row = (date, order, cost) => ({ 'Ship Date': date, 'Order #': order, Provider: 'Synthetic', Service: 'Ground', Package: 'Pkg', Items: '1', Zone: '5',
    'Shipping Cost': cost, 'Insurance Cost': '0', Weight: '12.00', 'Weight Unit': 'Ounce', Store: 'Succulents Box (Shopify)', Duties: '0', Taxes: '0', 'Import Fee': '0' });
  const text = toCsvText([row('01/07/2020', '9990001', '4.10'), row('01/08/2020', '9990002', '5.25')], [...SHIPPING_COST_REPORT_COLUMNS]);
  return { format: 'csv_text', text, requestedFrom: SYN_FROM, requestedTo: SYN_TO, rowCount: 2, shippingCostTotal: 9.35, exportedAt: '2020-01-20T12:00:00Z' };
};

export async function runStagingAcceptance({ base, adminSecret, ingestSecret, password = null, prod = null, bind = false, fetchImpl = fetch, log = console.log }) {
  const results = [];
  const record = (id, check, status, detail = '') => { results.push({ id, check, status, detail }); log(`${status.padEnd(7)} ${id} ${check}${detail ? ` — ${detail}` : ''}`); };
  const req = async (b, method, p, { body, headers = {} } = {}) => {
    const r = await fetchImpl(b + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* not JSON */ }
    return { status: r.status, json: j, text: t, headers: r.headers };
  };
  const A = { 'X-Admin-Secret': adminSecret }, I = { 'X-Ingest-Secret': ingestSecret };
  const check = async (id, name, fn) => { try { const d = await fn(); record(id, name, d?.notRun ? 'NOT RUN' : 'PASS', d?.detail || d?.notRun || ''); } catch (e) { record(id, name, 'FAIL', String(e.message || e).slice(0, 200)); } };
  const must = (c, msg) => { if (!c) throw new Error(msg); };

  await check('S1', 'health reports environment "staging"', async () => {
    const h = await req(base, 'GET', '/v1/health');
    must(h.status === 200 && h.json?.environment === 'staging', `health ${h.status} environment=${h.json?.environment}`);
    return { detail: `engine ${h.json.engineVersion}` };
  });
  await check('S2', 'all five controls false (settings + Worker environment)', async () => {
    const s = await req(base, 'GET', '/v1/admin/settings', { headers: A });
    must(s.status === 200, `settings ${s.status}`);
    const v = s.json.settings;
    const c = { shipping_cost_report_source_verified: v.shipping_cost_report_source_verified, provisional_publication_enabled: v.provisional_publication_enabled,
                publication_enabled: v.publication_enabled, PUBLICATION_ALLOWED: s.json.publicationAllowedInEnvironment, AUTOMATION_ENABLED: s.json.automationEnabledInEnvironment };
    must(Object.values(c).every(x => x === false), `controls ${JSON.stringify(c)}`);
    return { detail: 'five false' };
  });
  await check('S3', 'staging D1 bound to "staging"', async () => {
    let s = (await req(base, 'GET', '/v1/admin/settings', { headers: A })).json?.settings || {};
    if (!s.database_environment && bind) {
      const b = await req(base, 'POST', '/v1/admin/environment/bind', { headers: A, body: { environment: 'staging', reason: 'C8 staging acceptance: bind staging D1', actorLabel: 'staging-acceptance' } });
      must(b.status === 200, `bind ${b.status} ${b.json?.error}`);
      s = (await req(base, 'GET', '/v1/admin/settings', { headers: A })).json?.settings || {};
    }
    must(s.database_environment === 'staging', `database_environment=${s.database_environment ?? 'unbound'}${bind ? '' : ' (run with --bind once)'}`);
  });
  await check('S4', 'migrations through 0011 applied (C7 status route answers)', async () => {
    const r = await req(base, 'GET', '/v1/admin/cycles/2020-01-06', { headers: A });
    must(r.status === 200 && 'schedule' in (r.json || {}), `cycles ${r.status} ${r.json?.error || ''}`);
  });
  await check('S5', 'credentials are not interchangeable (no secret → 401/403)', async () => {
    const codes = await Promise.all([req(base, 'GET', '/v1/admin/settings'), req(base, 'POST', '/v1/ingest/catalog', { body: {} }),
      req(base, 'GET', '/v1/admin/settings', { headers: I }), req(base, 'POST', '/v1/ingest/catalog', { body: {}, headers: A })].map(async p => (await p).status));
    must(codes.every(c => c === 401 || c === 403), `statuses ${codes.join(',')}`);
  });
  let versionId = null;
  await check('S6', 'Shipping Cost Report upload is idempotent (synthetic 2020 week; second upload = source_no_change)', async () => {
    const one = await req(base, 'POST', '/v1/ingest/shipping-cost-report', { headers: I, body: synReport() });
    must(one.status === 200, `first ${one.status} ${one.json?.error || ''}`);
    versionId = one.json.versionId;
    const two = await req(base, 'POST', '/v1/ingest/shipping-cost-report', { headers: I, body: synReport() });
    must(two.status === 200 && two.json.sourceStatus === 'source_no_change' && two.json.versionId === versionId, `second ${two.status} ${two.json?.sourceStatus}`);
    return { detail: `first ${one.json.sourceStatus}/${one.json.status}` };
  });
  await check('S7', 'synthetic version left financially inert (rejected, owns no dates)', async () => {
    if (!versionId) return { notRun: 'no synthetic version' };
    const v = (await req(base, 'GET', `/v1/admin/shipping-cost/versions/${versionId}`, { headers: A })).json?.version;
    if (v?.status === 'pending_review') {
      const r = await req(base, 'POST', `/v1/admin/shipping-cost/versions/${versionId}/reject`, { headers: A, body: { reason: 'C8 synthetic acceptance upload', actorLabel: 'staging-acceptance' } });
      must(r.status === 200, `reject ${r.status}`);
    }
    const segs = (await req(base, 'GET', '/v1/admin/shipping-cost/segments', { headers: A })).json?.segments || [];
    must(!segs.some(s => s.versionId === versionId), 'synthetic version owns active dates');
    return { detail: `state ${v?.status === 'pending_review' ? 'rejected' : v?.status}` };
  });
  await check('S8', 'automation status (session) carries no secret, path, email or sheet address', async () => {
    if (!password) return { notRun: 'SB_STAGING_DASHBOARD_PASSWORD not set' };
    const l = await req(base, 'POST', '/v1/auth/login', { body: { password } });
    must(l.status === 200, `login ${l.status}`);
    const cookie = (l.headers.get('set-cookie') || '').split(';')[0];
    const s = await req(base, 'GET', '/v1/automation/status', { headers: { Cookie: cookie } });
    must(s.status === 200, `status ${s.status}`);
    for (const bad of [adminSecret, ingestSecret, 'docs.google', '@', 'LOCALAPPDATA', 'C:\\']) must(!s.text.includes(bad), 'status leaks a forbidden value');
    await req(base, 'POST', '/v1/auth/logout', { headers: { Cookie: cookie } });
  });
  await check('S9', 'production is untouched: separate environment, no staging version visible there (read-only)', async () => {
    if (!prod?.base || !prod?.adminSecret) return { notRun: 'SB_PROD_URL / SB_PROD_ADMIN_SECRET not set' };
    const h = await req(prod.base, 'GET', '/v1/health');
    must(h.json?.environment === 'production', `production health environment=${h.json?.environment}`);
    const list = (await req(prod.base, 'GET', '/v1/admin/shipping-cost/versions', { headers: { 'X-Admin-Secret': prod.adminSecret } })).json?.versions || [];
    must(!list.some(v => v.requestedFrom === SYN_FROM && v.requestedTo === SYN_TO), 'the synthetic staging version is visible in production');
  });
  return results;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const e = process.env;
  if (!e.SB_STAGING_URL || !e.SB_STAGING_ADMIN_SECRET || !e.SB_STAGING_INGEST_SECRET) { console.error('Set SB_STAGING_URL, SB_STAGING_ADMIN_SECRET and SB_STAGING_INGEST_SECRET'); process.exit(2); }
  if (/sb-gp-worker\./.test(e.SB_STAGING_URL) && !/staging/.test(e.SB_STAGING_URL)) { console.error('Refusing: SB_STAGING_URL looks like the production Worker'); process.exit(2); }
  const r = await runStagingAcceptance({ base: e.SB_STAGING_URL.replace(/\/+$/, ''), adminSecret: e.SB_STAGING_ADMIN_SECRET, ingestSecret: e.SB_STAGING_INGEST_SECRET,
    password: e.SB_STAGING_DASHBOARD_PASSWORD || null, prod: e.SB_PROD_URL ? { base: e.SB_PROD_URL.replace(/\/+$/, ''), adminSecret: e.SB_PROD_ADMIN_SECRET } : null,
    bind: process.argv.includes('--bind') });
  process.exitCode = r.some(x => x.status === 'FAIL') ? 1 : 0;
}
