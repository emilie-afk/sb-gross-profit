#!/usr/bin/env node
/**
 * Deploy-preview acceptance: the REAL catalog-refresh path
 *
 *   build-hook request → Netlify build hook → INCOMING_HOOK_BODY → build.py
 *   → Worker /v1/ingest/catalog → catalog_refresh resolved
 *
 * Run against a STAGING Worker + D1 and a Netlify branch deploy whose build
 * hook targets that branch (see docs/deploy-preview-acceptance.md):
 *
 *   SB_WORKER_URL=https://sb-gp-worker-staging.<acct>.workers.dev \
 *   SB_ADMIN_SECRET=… SB_INGEST_SECRET=… NETLIFY_BUILD_HOOK=https://api.netlify.com/build_hooks/<id> \
 *   node tools/catalog-refresh-acceptance.mjs [--branch weekly-automation-phase1] [--expiry]
 *
 * Optional production read-only check (no writes): PROD_WORKER_URL and
 * PROD_ADMIN_SECRET. When set, the script confirms that no catalog push reached
 * PRODUCTION during the run. Without them it prints SKIP, and the doc's manual
 * wrangler check applies.
 *
 * Secrets come from the environment only and are never printed. Each case
 * prints PASS / FAIL; exit 0 only if every case ran and passed. Nothing here
 * publishes or changes publication settings.
 */
const env = process.env;
const W = (env.SB_WORKER_URL || '').replace(/\/+$/, '');
const HOOK = env.NETLIFY_BUILD_HOOK || '';
const args = process.argv.slice(2);
const branch = args.includes('--branch') ? args[args.indexOf('--branch') + 1] : 'weekly-automation-phase1';
const withExpiry = args.includes('--expiry');
if (!/^https:\/\//.test(W) || !env.SB_ADMIN_SECRET || !env.SB_INGEST_SECRET || !/^https:\/\/api\.netlify\.com\/build_hooks\//.test(HOOK)) {
  console.error('Set SB_WORKER_URL, SB_ADMIN_SECRET, SB_INGEST_SECRET and NETLIFY_BUILD_HOOK (https://api.netlify.com/build_hooks/<id>).');
  process.exit(10);
}
if (!/staging/.test(W)) { console.error('SB_WORKER_URL must be the STAGING Worker (its URL must contain "staging").'); process.exit(10); }
const WEEK = '2099-01-05';                            // a far-future week so nothing real is touched
const RUN_STARTED = new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  — ${detail}`}`); };

async function api(method, path, { body, secret = 'admin' } = {}) {
  const h = { 'Content-Type': 'application/json', [secret === 'admin' ? 'X-Admin-Secret' : 'X-Ingest-Secret']: secret === 'admin' ? env.SB_ADMIN_SECRET : env.SB_INGEST_SECRET };
  const r = await fetch(W + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const newRefresh = async () => (await api('POST', '/v1/admin/catalog-refresh', { body: { weekStart: WEEK, actorLabel: 'acceptance' } })).json.refreshId;
const refresh = async id => (await api('GET', `/v1/admin/catalog-refresh/${id}`)).json;

/** The build-hook request: POST, Content-Type application/json, raw JSON body. */
async function triggerHook(rawBody, title) {
  const u = `${HOOK}?trigger_branch=${encodeURIComponent(branch)}&trigger_title=${encodeURIComponent(title)}`;
  const r = await fetch(u, { method: 'POST', headers: rawBody === null ? {} : { 'Content-Type': 'application/json' }, body: rawBody === null ? undefined : rawBody });
  return r.status;
}
/** Wait for the next catalog push that arrives after `since` (a build finishing). */
async function nextPush(since, minutes = 20) {
  for (const end = Date.now() + minutes * 60_000; Date.now() < end; await sleep(30_000)) {
    const p = (await api('GET', `/v1/admin/catalog-pushes?since=${encodeURIComponent(since)}`)).json?.pushes || [];
    if (p.length) return p[p.length - 1];
  }
  return null;
}

async function runCase(name, rawBody, expect) {
  const since = new Date().toISOString();
  const hs = await triggerHook(rawBody, `acceptance: ${name}`);
  if (hs < 200 || hs >= 300) return check(name, false, `build hook answered ${hs}`);
  const push = await nextPush(since);
  if (!push) return check(name, false, 'no catalog push arrived within 20 minutes (build failed or CATALOG_PUSH_URL unset?)');
  return expect(push);
}

// 0. Publication controls are off on staging, before anything else.
async function publicationOff(label) {
  const s = (await api('GET', '/v1/admin/settings')).json;
  check(`${label}: publication_enabled=false, carrier_fee_priority_locked=false, PUBLICATION_ALLOWED=false`,
    s?.settings?.publication_enabled === false && s?.settings?.carrier_fee_priority_locked === false && s?.publicationAllowedInEnvironment === false,
    JSON.stringify({ p: s?.settings?.publication_enabled, c: s?.settings?.carrier_fee_priority_locked, env: s?.publicationAllowedInEnvironment }));
}
await publicationOff('before');

// 1. The normal cycle: the pushed catalog resolves exactly this refresh.
const r1 = await newRefresh();
await runCase('hook payload → INCOMING_HOOK_BODY → build.py → refresh fulfilled', JSON.stringify({ refreshId: r1, weekStart: WEEK }), async p => {
  const s = await refresh(r1);
  check('the push echoed the same refreshId', p.refresh?.refreshId === r1, JSON.stringify(p.refresh));
  check('the refresh is resolved (fulfilled, or rejected if the sheets failed validation)', ['fulfilled', 'rejected'].includes(s.status), s.status);
  check('it resolved to the pushed catalog revision', s.status !== 'fulfilled' || s.catalogRev === p.catalogRev, `${s.catalogRev} vs ${p.catalogRev}`);
});
const firstRev = (await refresh(r1)).catalogRev;

// 2. Identical content again: a NEW refresh is still fulfilled.
const r2 = await newRefresh();
await runCase('identical accepted content fulfils the current refresh', JSON.stringify({ refreshId: r2, weekStart: WEEK }), async () => {
  const s = await refresh(r2);
  check('refresh fulfilled with the same content revision', s.status === 'fulfilled' && s.catalogRev === firstRev, `${s.status} ${s.catalogRev}`);
});

// 3–6. Builds that must NOT resolve a pending refresh. A fresh pending refresh
// per case, so a slow build queue cannot turn "untouched" into "expired".
for (const [name, raw, want] of [
  ['a build with no body resolves nothing', null, 'none'],
  ['a build with {} resolves nothing', '{}', 'none'],
  ['a malformed refreshId resolves nothing', JSON.stringify({ refreshId: 'crf_not-a-real-id' }), 'none'],   // build.py drops it
  ['an unrelated well-formed refreshId resolves nothing', JSON.stringify({ refreshId: 'crf_00000000000000000000' }), 'unknown'],
]) {
  const pending = await newRefresh();
  await runCase(name, raw, async p => {
    check(`${name}: push refresh status is ${want}`, p.refresh?.status === want, JSON.stringify(p.refresh));
    check(`${name}: the pending refresh is untouched`, (await refresh(pending)).status === 'pending');
  });
}

// 6. Rejected content marks the refresh rejected. Forcing the live vendor sheets
//    to shrink is unsafe, so this case posts a deliberately shrunken catalog
//    straight to the staging Worker (the Netlify leg is covered by case 1).
const r6 = await newRefresh();
const shrunk = { tables: { vendor_costs: { 'Live to Give': { A: { unitCost: 1 } } } }, meta: { source: 'acceptance', refreshId: r6 } };
const rej = await api('POST', '/v1/ingest/catalog', { body: shrunk, secret: 'ingest' });
check('rejected catalog content marks the refresh rejected (direct push)', rej.json?.refresh?.status === 'rejected' && (await refresh(r6)).status === 'rejected', JSON.stringify(rej.json?.refresh));

// 7. Expiry (optional, waits 46 minutes).
if (withExpiry) {
  const r7 = await newRefresh();
  console.log('waiting 46 minutes for the refresh to expire…');
  await sleep(46 * 60_000);
  await runCase('an expired refresh is not fulfilled by a late build', JSON.stringify({ refreshId: r7, weekStart: WEEK }), async p => {
    check('late push reports expired', p.refresh?.status === 'expired', JSON.stringify(p.refresh));
    check('refresh stays expired', (await refresh(r7)).status === 'expired');
  });
} else console.log('SKIP  expiry case (run with --expiry; covered by unit tests)');

await publicationOff('after');
if (env.PROD_WORKER_URL && env.PROD_ADMIN_SECRET) {
  const r = await fetch(`${env.PROD_WORKER_URL.replace(/\/+$/, '')}/v1/admin/catalog-pushes?since=${encodeURIComponent(RUN_STARTED)}`,
    { headers: { 'X-Admin-Secret': env.PROD_ADMIN_SECRET } });
  const j = await r.json().catch(() => null);
  check('no catalog push reached the PRODUCTION Worker/D1 during this run', r.ok && Array.isArray(j?.pushes) && j.pushes.length === 0, JSON.stringify(j?.pushes?.length));
} else console.log('SKIP  production-untouched check (set PROD_WORKER_URL and PROD_ADMIN_SECRET, or use the manual wrangler check)');

const failed = results.filter(x => !x).length;
console.log(failed ? `\n${failed} check(s) failed` : `\nAll ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
