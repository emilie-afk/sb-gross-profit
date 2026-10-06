/**
 * Free-tier automation (owner decisions 2026-10-05): Shipping Cost Reports accepted automatically when
 * they pass the automated checks (unusual values flagged, invalid reports refused and re-exported),
 * the week's pinned catalog accepted without replacing it, eligible weeks published automatically
 * once every control allows it, and the reporting start date (a partial first week).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freeTierEnv, api, ok, client, scrPayload, dataset, freeTierRun, runVerifier } from './freeTierHarness.mjs';
import * as FT from '../../automation/collector/src/freeTier.mjs';
import { reportRow } from '../../tests/fixtures-shipping-cost.mjs';
import { addDays } from '../../shared/normalized.js';
import { weekStatus } from '../src/weekStatus.js';

const rows = (list, extra = {}) => list.map(([date, order, cost, more = {}]) => reportRow({ date, order, cost, paid: '5.00', ...extra, ...more }));
const FROM = '2026-08-03', TO = '2026-08-09';
const WEEK1 = [['2026-08-03', '900101', '6.25'], ['2026-08-04', '900102', '7.10'], ['2026-08-05', '900103', '5.55'], ['2026-08-06', '900104', '8.00'], ['2026-08-07', '900105', '6.00']];
const automatic = async env => {
  await ok(api(env, 'POST', '/v1/admin/settings', { shipping_cost_auto_accept_enabled: true, reason: 'test: automatic acceptance' }), 'auto on');
  await ok(api(env, 'POST', '/v1/admin/settings', { shipping_cost_auto_accept_rules: 'flag_and_accept', reason: 'test: flag and accept' }), 'rules');
};

test('automatic SCR acceptance: a new report is accepted without a person; unusual values and changed costs are flags', async () => {
  const env = await freeTierEnv(), c = client(env);
  assert.equal((await api(env, 'POST', '/v1/admin/settings', { shipping_cost_auto_accept_rules: 'anything', reason: 'test: invalid' })).status, 400);
  await automatic(env);
  const v1 = await FT.uploadShippingCostReport(c, scrPayload(rows(WEEK1), FROM, TO));
  assert.deepEqual([v1.status, v1.reviewReasons, v1.flags, v1.automatic], ['accepted', [], ['first_version'], true]);
  // Next week: a row over the review cap and insurance → accepted and flagged (insurance is disclosed, not added).
  const W2F = addDays(FROM, 7), W2T = addDays(TO, 7);
  const v2 = await FT.uploadShippingCostReport(c, scrPayload(rows([[W2F, '900201', '150.00'], [addDays(W2F, 1), '900202', '6.00', { insurance: '2.50' }]]), W2F, W2T));
  assert.equal(v2.status, 'accepted');
  assert.deepEqual(v2.flags.sort(), ['nonzero_insurance_cost', 'over_review_cap']);
  // A later report changes one accepted cost (a valid late correction) and drops another order's cost.
  const later = WEEK1.map(([d, o, cost]) => [d, o, o === '900102' ? '9.99' : cost]).filter(([, o]) => o !== '900104');
  const v3 = await FT.uploadShippingCostReport(c, scrPayload(rows(later), FROM, TO, '2026-08-12T15:00:00Z'));
  assert.equal(v3.dates['2026-08-04'], 'changed', 'the changed cost is activated');
  assert.equal(v3.dates['2026-08-06'], 'identical', 'the omitted accepted cost is kept, so nothing on that date changes');
  assert.deepEqual([v3.status, v3.flags.sort(), v3.changedDates, v3.omittedDates], ['accepted', ['accepted_cost_removed', 'changed_cost'], ['2026-08-04'], ['2026-08-06']]);
  const owner = d => env.DB.prepare('SELECT version_id FROM scr_day_owner WHERE ship_date = ?1').bind(d).first();
  assert.equal((await owner('2026-08-04')).version_id, v3.versionId);
  assert.equal((await owner('2026-08-06')).version_id, v1.versionId);
  // Neither waits for a person: the week is not blocked by a "newer report pending review".
  const st = await weekStatus(env.DB, FROM, new Date('2026-08-13T00:00:00Z'));
  assert.ok(!st.pending.some(p => /pending_review|newer_pending/.test(p.code)), JSON.stringify(st.pending));
  assert.deepEqual(st.sources.shippingReport.changedDates, ['2026-08-04']);
  assert.ok(st.sources.shippingReport.flags.includes('changed_cost'));
  const decisions = (await env.DB.prepare("SELECT kind, actor_class FROM scr_decision WHERE version_id IN (?1, ?2, ?3)").bind(v1.versionId, v2.versionId, v3.versionId).all()).results;
  assert.ok(decisions.every(x => x.kind === 'auto_activate' && x.actor_class === 'ingest_secret'), 'every decision is recorded as automatic');
});

test('automatic SCR acceptance: an omitted order keeps its accepted cost while corrections and additions on the same date apply', async () => {
  const env = await freeTierEnv(), c = client(env);
  await automatic(env);
  const D = '2026-08-04';
  const v1 = await FT.uploadShippingCostReport(c, scrPayload(rows([[D, '900301', '5.00'], [D, '900302', '7.00'], ['2026-08-05', '900303', '4.00']]), FROM, TO));
  assert.equal(v1.status, 'accepted');
  // Later: 900301 omitted, 900302 corrected $7 → $9, 900304 new at $8 — all on the same date.
  const v2 = await FT.uploadShippingCostReport(c, scrPayload(rows([[D, '900302', '9.00'], [D, '900304', '8.00'], ['2026-08-05', '900303', '4.00']]), FROM, TO, '2026-08-12T15:00:00Z'));
  assert.deepEqual([v2.status, v2.dates[D], v2.omittedDates, v2.flags.sort()], ['accepted', 'changed', [D], ['accepted_cost_removed', 'changed_cost']]);
  const owner = await env.DB.prepare('SELECT o.version_id, d.groups FROM scr_day_owner o JOIN scr_day d ON d.version_id = o.version_id AND d.ship_date = o.ship_date WHERE o.ship_date = ?1').bind(D).first();
  assert.equal(owner.version_id, v2.versionId, 'the date is not frozen: the new report owns it');
  assert.deepEqual(JSON.parse(owner.groups), [['900301', 500, 1], ['900302', 900, 1], ['900304', 800, 1]], 'kept $5, corrected $9, added $8');
  const kept = JSON.parse((await env.DB.prepare('SELECT outcome FROM scr_version WHERE version_id = ?1').bind(v2.versionId).first()).outcome).preserved;
  assert.deepEqual(kept, { [D]: [['900301', v1.versionId]] }, 'the kept cost names the report it comes from');
  // A third report that omits it again keeps it from the ORIGINAL source; one that brings it back replaces it.
  const v3 = await FT.uploadShippingCostReport(c, scrPayload(rows([[D, '900302', '9.50'], [D, '900304', '8.00'], ['2026-08-05', '900303', '4.00']]), FROM, TO, '2026-08-13T15:00:00Z'));
  assert.deepEqual(JSON.parse((await env.DB.prepare('SELECT outcome FROM scr_version WHERE version_id = ?1').bind(v3.versionId).first()).outcome).preserved, { [D]: [['900301', v1.versionId]] });
  const v4 = await FT.uploadShippingCostReport(c, scrPayload(rows([[D, '900301', '5.25'], [D, '900302', '9.50'], [D, '900304', '8.00'], ['2026-08-05', '900303', '4.00']]), FROM, TO, '2026-08-14T15:00:00Z'));
  assert.deepEqual([v4.dates[D], v4.omittedDates], ['changed', []]);
  assert.equal((await env.DB.prepare("SELECT json_extract(outcome, '$.preserved') AS p FROM scr_version WHERE version_id = ?1").bind(v4.versionId).first()).p, null);
});

test('flags of a report that owns no date of the week still show on that week', async () => {
  const env = await freeTierEnv(), c = client(env);
  await automatic(env);
  const v1 = await FT.uploadShippingCostReport(c, scrPayload(rows(WEEK1), FROM, TO));
  // A later report whose only difference is an omitted order: nothing is activated, it owns no date.
  const v2 = await FT.uploadShippingCostReport(c, scrPayload(rows(WEEK1.filter(([, o]) => o !== '900103')), FROM, TO, '2026-08-12T15:00:00Z'));
  assert.deepEqual([v2.status, v2.omittedDates, v2.flags], ['no_change', ['2026-08-05'], ['accepted_cost_removed']]);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM scr_day_owner WHERE version_id = ?1').bind(v2.versionId).first()).n, 0, 'owns no date');
  const st = await weekStatus(env.DB, FROM, new Date('2026-08-13T00:00:00Z'));
  assert.ok(st.sources.shippingReport.flags.includes('accepted_cost_removed'), JSON.stringify(st.sources.shippingReport));
  assert.deepEqual(st.sources.shippingReport.omittedDates, ['2026-08-05']);
  const { reportFlagsText } = await import('../../js/weeklyReports.js');
  assert.match(reportFlagsText(st), /omitted accepted shipping costs.*kept.*2026-08-05/);
  // Another week is not flagged by it.
  const other = await weekStatus(env.DB, addDays(FROM, 7), new Date('2026-08-20T00:00:00Z'));
  assert.ok(!(other.sources.shippingReport.flags || []).includes('accepted_cost_removed'));
  void v1;
});

test('automatic SCR acceptance: a kept cost is verified against the report it came from (end to end)', async () => {
  const d = dataset({ n: 80 });
  const ft = await freeTierRun(d);
  const { env, c } = ft;
  await automatic(env);
  // The dataset's report, re-exported later with one order omitted on a date that has other orders, one corrected and one added.
  const { parseCSV } = await import('../../shared/calculator.js');
  const { toCsvText } = await import('../../shared/adapters/shopifyCsv.js');
  const src = parseCSV(d.scr.text), cols = Object.keys(src[0]);
  const dateCol = cols.find(k => /ship date/i.test(k)), orderCol = cols.find(k => /order/i.test(k)), costCol = cols.find(k => /shipping cost/i.test(k));
  const byDate = new Map(); for (const r of src) (byDate.get(r[dateCol]) || byDate.set(r[dateCol], []).get(r[dateCol])).push(r);
  const [, sameDay] = [...byDate].find(([, list]) => new Set(list.map(r => r[orderCol])).size >= 3);
  const [dropped, corrected] = [...new Set(sameDay.map(r => r[orderCol]))];
  const rows2 = src.filter(r => r[orderCol] !== dropped).map(r => (r[orderCol] === corrected ? { ...r, [costCol]: (Number(r[costCol]) + 2).toFixed(2) } : r));
  rows2.push({ ...sameDay.find(r => r[orderCol] === corrected), [costCol]: '1.11' });
  const p2 = { ...d.scr, text: toCsvText(rows2, cols), exportedAt: `${addDays(d.scr.requestedTo, 2)}T15:00:00Z` };
  const p = (await import('../../shared/adapters/shippingCostReport.js')).parseShippingCostReport(rows2, { requestedFrom: d.scr.requestedFrom, requestedTo: d.scr.requestedTo });
  p2.rowCount = p.rowCount; p2.shippingCostTotal = p.shippingCostCents / 100;
  const v = await FT.uploadShippingCostReport(c, p2);
  assert.equal(v.status, 'accepted');
  assert.equal(v.omittedDates.length, 1);
  const cache = FT.newCache();
  let checked = 0;
  for (const w of d.weeks) {
    const r = await FT.computeAndUploadWeek(c, w, cache);
    if (r.status !== 'computed') continue;
    const vr = await runVerifier(env, r.snapshotId);
    assert.equal(vr.body.status, 'verified', `${w}: ${JSON.stringify(vr.body)}`);
    checked++;
  }
  assert.ok(checked >= 1, 'the affected week was recomputed and verified');
  // A kept cost altered in storage (not what its source report says) is caught by the verifier's provenance check.
  const D = v.omittedDates[0];
  const row = await env.DB.prepare('SELECT groups FROM scr_day WHERE version_id = ?1 AND ship_date = ?2').bind(v.versionId, D).first();
  assert.ok(row, 'the new report owns the date, with the omitted order kept');
  const keptKey = JSON.parse((await env.DB.prepare('SELECT outcome FROM scr_version WHERE version_id = ?1').bind(v.versionId).first()).outcome).preserved[D][0][0];
  const forged = JSON.parse(row.groups).map(g => (g[0] === keptKey ? [g[0], g[1] + 100, g[2]] : g));
  const { dayHash } = await import('../../shared/scrDays.js');
  const h = await dayHash(D, forged);
  await env.DB.prepare('UPDATE scr_day SET groups = ?3, day_hash = ?4 WHERE version_id = ?1 AND ship_date = ?2').bind(v.versionId, D, JSON.stringify(forged), h).run();
  await env.DB.prepare('UPDATE scr_day_owner SET day_hash = ?2 WHERE ship_date = ?1').bind(D, h).run();
  const statuses = [];
  for (const w of d.weeks) {
    const r = await FT.computeAndUploadWeek(c, w, FT.newCache());
    if (r.status === 'computed') statuses.push((await runVerifier(env, r.snapshotId)).body);
  }
  assert.ok(statuses.some(b => b.status === 'mismatch' && b.provenanceMismatches > 0), JSON.stringify(statuses.map(b => [b.status, b.provenanceMismatches])));
});

test('automatic SCR acceptance: a report that fails an automated check is refused, shown exactly, and re-exported', async () => {
  const env = await freeTierEnv(), c = client(env);
  await automatic(env);
  // Exported on the last requested date: the trailing date may be incomplete.
  const v = await FT.uploadShippingCostReport(c, scrPayload(rows(WEEK1), FROM, TO, `${TO}T18:00:00Z`));
  assert.deepEqual([v.status, v.invalidReasons], ['rejected', ['possible_incomplete_trailing_date']]);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM scr_day_owner').first()).n, 0, 'nothing is activated, no cost becomes $0');
  const st = await weekStatus(env.DB, FROM, new Date('2026-08-11T00:00:00Z'));
  assert.ok(st.pending.some(p => p.code === 'shipping_report_invalid'));
  assert.deepEqual(st.sources.shippingReport.invalid.reasons, ['possible_incomplete_trailing_date']);
  const plan = await FT.freeTierPipeline({ workerUrl: 'https://w.local', ingestSecret: env.INGEST_SECRET, closedWeek: FROM, fetchImpl: (await import('./freeTierHarness.mjs')).bridge(env) }).weekPlan();
  assert.equal(plan.collected.shipping_cost_report, 'missing', 'the collector re-exports the report on its next attempt');
  // The next export (after the trailing date closed, with its late row) is accepted automatically.
  const ok2 = await FT.uploadShippingCostReport(c, scrPayload(rows([...WEEK1, [TO, '900109', '4.40']]), FROM, TO));
  assert.equal(ok2.status, 'accepted');
});

test('pinned catalog, provisional visibility and automatic publication of eligible verified weeks only', async () => {
  const d = dataset({ n: 80 });
  const ft = await freeTierRun(d);
  const { env, c } = ft, [w0, w1, w2, w3] = d.weeks;
  const gateOf = async w => JSON.parse((await env.DB.prepare('SELECT r.gate FROM snapshot s JOIN reporting_run r ON r.run_id = s.run_id WHERE s.week_start = ?1 ORDER BY s.revision DESC LIMIT 1').bind(w).first()).gate);
  assert.ok((await gateOf(w1)).failures.some(f => f.code === 'catalog_stale'), 'a week with no refresh of its own starts stale');
  const pinned = (await env.DB.prepare('SELECT catalog_rev FROM snapshot WHERE week_start = ?1 ORDER BY revision DESC LIMIT 1').bind(w1).first()).catalog_rev;
  const acc = (w, rev, reason = 'test: pinned catalog is right for this period') => api(env, 'POST', `/v1/admin/weeks/${w}/accept-pinned-catalog`, { catalogRev: rev, reason });
  assert.equal((await acc(w1, 'cat_0000000000000000')).json.error, 'not_pinned_catalog', 'no other catalog can be accepted (nothing is replaced)');
  assert.equal((await acc(w1, pinned, 'short')).status, 400);
  for (const w of [w0, w1, w2]) await ok(acc(w, pinned), 'accept pinned');
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM snapshot WHERE catalog_rev <> ?1').bind(pinned).first()).n, 0, 'every week keeps its pinned catalog');
  // Publication offered before the controls are on: refused with the exact reason.
  assert.deepEqual(await c.call('POST', `/v1/collect/weeks/${w1}/publish`, { json: {} }).then(r => [r.published, r.reason]), [false, 'gate_failed']);
  // Approved controls, then recompute + verify; only eligible weeks publish.
  for (const [k, v] of [['provisional_publication_enabled', true], ['publication_enabled', true], ['ss_coverage_threshold', 0.85]]) await ok(api(env, 'POST', '/v1/admin/settings', { [k]: v, reason: `test: approved ${k}` }), k);
  env.PUBLICATION_ALLOWED = 'true'; env.PUBLICATION_EARLIEST_WEEK = w1;
  const cache = FT.newCache();
  const cv = async w => { const r = await FT.computeAndUploadWeek(c, w, cache); assert.equal(r.status, 'computed', `${w}: ${JSON.stringify(r)}`); assert.equal((await runVerifier(env, r.snapshotId)).body.status, 'verified'); return r; };
  const pub = async w => c.call('POST', `/v1/collect/weeks/${w}/publish`, { json: {} });
  for (const w of [w0, w1, w2, w3]) await cv(w);
  const g1 = await gateOf(w1);
  assert.equal(g1.passed, true, JSON.stringify(g1.failures));
  assert.ok(g1.warnings.some(x => x.code === 'catalog_reused') && g1.warnings.some(x => x.code === 'shipping_source_unverified'), 'provisional disclosures stay');
  assert.equal((await pub(w0)).reason, 'costs_not_period_accurate');
  assert.equal((await pub(w1)).published, true);
  const g2 = await gateOf(w2);
  assert.equal(g2.passed, true, JSON.stringify(g2.failures));
  assert.equal((await pub(w2)).reason, 'comparison_stale', 'computed before the prior week was published');
  await cv(w2);
  assert.equal((await pub(w2)).published, true);
  assert.equal((await pub(w2)).alreadyPublished, true, 'a retry publishes nothing twice');
  await cv(w3);
  assert.equal((await pub(w3)).reason, 'gate_failed', 'no pinned-catalog acceptance → still stale');
  const seen = (await api(env, 'GET', '/v1/weeks')).json.weeks;      // without includeDrafts: what a dashboard session sees
  assert.deepEqual(seen.map(w => w.weekStart).sort(), [w1, w2], 'only the eligible verified weeks are visible');
  assert.ok(seen.every(w => w.revisions[0].status === 'published' && w.revisions[0].verification === 'verified' && w.revisions[0].shippingCoverage));
});

test('reporting start: the week containing it is a partial week; a week ending before it is not reported', async () => {
  const d = dataset({ n: 80 });
  const ft = await freeTierRun(d, { verify: false });
  const { env, c } = ft, w = d.weeks[3], start = addDays(w, 3);
  env.REPORTING_START_DATE = start;
  const r = await FT.computeAndUploadWeek(c, w, FT.newCache());
  assert.equal(r.status, 'computed');
  assert.equal((await runVerifier(env, r.snapshotId)).body.status, 'verified', 'the verifier recomputes the same partial week');
  const s = (await api(env, 'GET', `/v1/snapshot/${w}?includeDrafts=1`)).json;
  assert.deepEqual(s.totals.labels.partialWeek, { from: start, to: addDays(w, 6), reportingStart: start });
  assert.ok(s.narrative.points.some(p => p.startsWith('Partial reporting week')));
  const all = await env.DB.prepare("SELECT MIN(json_extract(j.value, '$.business_date')) AS first FROM snapshot_blob b, json_each(b.body_text, '$.orders') j WHERE b.snapshot_id = ?1 AND b.part LIKE 'orders:%'").bind(r.snapshotId).first();
  assert.ok(all.first >= start, 'no order before the reporting start');
  const before = await FT.computeAndUploadWeek(c, d.weeks[2], FT.newCache());
  assert.deepEqual([before.status, before.code], ['pending', 'before_reporting_start']);
});
