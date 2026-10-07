/**
 * Free-tier path: Shipping Cost Report acceptance rules (owner decisions 2026-09-29),
 * privacy validation before retention, result-upload guards, idempotency, the
 * verifier's tamper detection and output privacy, week status and publication.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { freeTierEnv, api, ok, client, scrPayload, dataset, freeTierRun, runVerifier, changes, ORIGIN, bridge } from './freeTierHarness.mjs';
import * as FT from '../../automation/collector/src/freeTier.mjs';
import { reportRow } from '../../tests/fixtures-shipping-cost.mjs';
import { addDays, stableStringify, weekStartOf } from '../../shared/normalized.js';
import { toCsvText } from '../../shared/adapters/shopifyCsv.js';
import { orderBodyString } from '../../shared/bundle.js';
import { PUBLIC_KEYS } from '../../shared/verify.js';
import { csvOrder } from '../../tests/fixtures-normalized.mjs';
import { prepareShopifyUpload } from '../../shared/adapters/shopifyCsv.js';

const FROM = '2026-08-03', TO = '2026-08-09';                 // one Mon–Sun week
const rows = (list, extra = {}) => list.map(([date, order, cost, more = {}]) => reportRow({ date, order, cost, paid: '5.00', ...extra, ...more }));
const WEEK1 = [['2026-08-03', '900101', '6.25'], ['2026-08-04', '900102', '7.10'], ['2026-08-05', '900103', '5.55'], ['2026-08-06', '900104', '8.00'], ['2026-08-07', '900105', '6.00']];

const autoAccept = (env, on) => ok(api(env, 'POST', '/v1/admin/settings', { shipping_cost_auto_accept_enabled: on, reason: `test: auto-acceptance ${on ? 'on' : 'off'}` }), 'auto-accept setting');

async function accepted(env, c, list = WEEK1, from = FROM, to = TO) {
  const v = await FT.uploadShippingCostReport(c, scrPayload(rows(list), from, to));
  if (v.status === 'pending_review') await ok(api(env, 'POST', `/v1/admin/scr/versions/${v.versionId}/accept`, { reason: 'test: first version reviewed' }), 'accept');
  return v;
}

test('SCR: the first version waits for review; an identical re-export writes nothing', async () => {
  const env = await freeTierEnv(), c = client(env);
  const v1 = await FT.uploadShippingCostReport(c, scrPayload(rows(WEEK1), FROM, TO));
  assert.equal(v1.status, 'pending_review');
  assert.deepEqual(v1.reviewReasons, ['first_version', 'auto_acceptance_disabled']);
  assert.equal((await api(env, 'GET', '/v1/admin/scr/versions')).json.versions[0].status, 'pending_review');
  await ok(api(env, 'POST', `/v1/admin/scr/versions/${v1.versionId}/accept`, { reason: 'test: first version reviewed' }), 'accept');
  const before = changes(env);
  const again = await FT.uploadShippingCostReport(c, scrPayload(rows(WEEK1), FROM, TO));
  assert.equal(again.sourceStatus, 'already_have');
  assert.equal(changes(env), before, 'identical re-export: 0 rows written');
  // The same rows in another order (a different file): a new source, every date identical → no_change, nothing activated.
  const t0 = changes(env);
  const later = await FT.uploadShippingCostReport(c, scrPayload(rows([...WEEK1].reverse()), FROM, TO, '2026-08-12T15:00:00Z'));
  assert.equal(later.status, 'no_change');
  assert.equal(later.counts.identical, 7);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM scr_day WHERE version_id = ?1').bind(later.versionId).first()).n, 0);
  assert.ok(changes(env) - t0 <= 6, 'only the new source record, its segment and the version row');
});

test('SCR: $0.00 actual cost, a cost above the review cap and non-zero insurance/duties/taxes/import fee go to review; $0 customer-paid shipping does not', async () => {
  const env = await freeTierEnv(), c = client(env);
  await accepted(env, c);
  const next = (d, o, cost, more) => [addDays(d, 7), o, cost, more];
  const W2F = addDays(FROM, 7), W2T = addDays(TO, 7);
  const cases = [
    [[next('2026-08-03', '900201', '0.00')], ['zero_shipping_cost']],
    [[next('2026-08-03', '900202', '100.01')], ['over_review_cap']],
    [[next('2026-08-03', '900203', '100.00')], []],                                 // at the cap: fine
    [[next('2026-08-03', '900204', '6.00', { insurance: '1.00' })], ['nonzero_insurance_cost']],
    [[next('2026-08-03', '900205', '6.00', { extra: { Duties: '0.50' } })], ['nonzero_duties']],
    [[next('2026-08-03', '900206', '6.00', { paid: '0.00' })], []],                  // prepaid subscription: customer paid $0
  ];
  for (const [list, want] of cases) {
    const env2 = await freeTierEnv(), c2 = client(env2);
    await accepted(env2, c2);
    await autoAccept(env2, true);
    const v = await FT.uploadShippingCostReport(c2, scrPayload(rows(list), W2F, W2T));
    assert.deepEqual(v.reviewReasons, want, JSON.stringify(list));
    assert.equal(v.status, want.length ? 'pending_review' : 'accepted');
    if (want.length) {
      const owners = (await env2.DB.prepare('SELECT COUNT(*) AS n FROM scr_day_owner WHERE ship_date >= ?1').bind(W2F).first()).n;
      assert.equal(owners, 0, 'nothing activated while in review');
      const kept = (await env2.DB.prepare('SELECT COUNT(*) AS n FROM scr_day WHERE version_id = ?1').bind(v.versionId).first()).n;
      assert.ok(kept > 0, 'the held value is kept, not discarded');
    }
  }
  // The cap is an audited setting.
  await autoAccept(env, true);
  assert.equal((await api(env, 'POST', '/v1/admin/settings', { shipping_cost_review_cap_cents: 5000, reason: 'test: lower cap' })).status, 200);
  const v = await FT.uploadShippingCostReport(c, scrPayload(rows([next('2026-08-03', '900207', '60.00')]), W2F, W2T));
  assert.deepEqual(v.reviewReasons, ['over_review_cap']);
  assert.equal((await api(env, 'POST', '/v1/admin/settings', { shipping_cost_review_cap_cents: 50, reason: 'test: too low' })).status, 400);
});

test('SCR: a late cost for an order with no accepted cost is filled in automatically and its week gets a new unpublished draft', async () => {
  const d = dataset({ n: 120, scr: { zeroEvery: 1e9 } });            // no $0.00 rows: those would (rightly) send the re-export to review
  const ft = await freeTierRun(d);
  const env = ft.env, c = ft.c;
  await autoAccept(env, true);
  // An order the report has no row for yet (the fixture leaves every 29th order unshipped).
  const m = d.meta.find(x => x.k % 29 === 0 && x.day >= d.weeks[1]);
  const week = weekStartOf(m.day), target = m.number, date = m.day;
  const before = (await api(env, 'GET', `/v1/snapshot/${week}/orders/${encodeURIComponent('#' + target)}?includeDrafts=1`)).json.order;
  assert.equal(before.shipPaidSS, 0, 'awaiting shipping cost before the late row');
  // Re-export of the whole window plus one row for that order on an already-owned date.
  const extended = appendRow(d.scr, reportRow({ date, order: target, cost: '6.40', paid: '5.99' }), '2020-03-17T15:00:00Z');
  const v = await FT.uploadShippingCostReport(c, extended);
  assert.equal(v.status, 'accepted', JSON.stringify(v));
  assert.ok(v.counts.fill_in >= 1 && v.counts.held === 0);
  assert.ok(v.affectedWeeks.includes(week));
  const r = await FT.computeAndUploadWeek(c, week, ft.cache);
  assert.equal(r.status, 'computed');
  assert.equal(r.revision, 2);
  assert.notEqual(r.snapshotStatus, 'published');
  const o = (await api(env, 'GET', `/v1/snapshot/${week}/orders/${encodeURIComponent('#' + target)}?includeDrafts=1`)).json.order;
  assert.equal(o.shipPaidSS, 6.4);
  assert.equal((await runVerifier(env, r.snapshotId)).body.status, 'verified');
});
function appendRow(payload, raw, exportedAt) {
  const { SHIPPING_COST_REPORT_COLUMNS: cols } = { SHIPPING_COST_REPORT_COLUMNS: payload.text.split('\n')[0].split(',') };
  const row = Object.fromEntries(cols.map(c => [c, raw[c]]));
  const text = payload.text + toCsvText([row], cols).split('\n').slice(1).join('\n');
  const cents = Math.round(Number(raw['Shipping Cost']) * 100);
  return { ...payload, text, rowCount: payload.rowCount + 1, shippingCostTotal: Math.round(payload.shippingCostTotal * 100 + cents) / 100, exportedAt };
}

test('SCR: a changed or removed accepted cost is held for review with before/after; accepting activates it; rollback restores', async () => {
  const env = await freeTierEnv(), c = client(env);
  await accepted(env, c);
  await autoAccept(env, true);
  const changed = WEEK1.map(r => (r[1] === '900102' ? [r[0], r[1], '7.35'] : r)).filter(r => r[1] !== '900105');
  const v = await FT.uploadShippingCostReport(c, scrPayload(rows(changed), FROM, TO, '2026-08-11T15:00:00Z'));
  assert.equal(v.status, 'partially_accepted');
  assert.deepEqual(v.heldDates, ['2026-08-04', '2026-08-07']);
  const owner = async d => (await env.DB.prepare('SELECT version_id FROM scr_day_owner WHERE ship_date = ?1').bind(d).first()).version_id;
  assert.notEqual(await owner('2026-08-04'), v.versionId, 'held: the accepted cost stays in force');
  const detail = (await api(env, 'GET', `/v1/admin/scr/versions/${v.versionId}`)).json;
  const ch = detail.review.find(x => x.date === '2026-08-04').changes;
  assert.deepEqual(ch, [{ orderKey: '900102', beforeCents: 710, afterCents: 735, beforeRows: 1, afterRows: 1 }]);
  assert.deepEqual(detail.review.find(x => x.date === '2026-08-07').changes, [{ orderKey: '900105', beforeCents: 600, afterCents: null, beforeRows: 1, afterRows: null }]);
  const acc = await ok(api(env, 'POST', `/v1/admin/scr/versions/${v.versionId}/accept`, { reason: 'test: carrier adjustment confirmed' }), 'accept');
  assert.deepEqual(acc.activatedDates, ['2026-08-04', '2026-08-07']);
  assert.equal(await owner('2026-08-04'), v.versionId);
  const last = (await env.DB.prepare('SELECT activation_id FROM scr_activation ORDER BY at DESC LIMIT 1').first()).activation_id;
  await ok(api(env, 'POST', `/v1/admin/scr/activations/${last}/rollback`, { reason: 'test: undo' }), 'rollback');
  assert.notEqual(await owner('2026-08-04'), v.versionId);
});

test('SCR: new cost for an order that already has accepted cost on another date is held; a gap and a same-day export go to review', async () => {
  const env = await freeTierEnv(), c = client(env);
  await accepted(env, c);
  await autoAccept(env, true);
  const add = [...WEEK1, ['2026-08-06', '900101', '3.00']];                     // 900101 already costed on 08-03
  const v = await FT.uploadShippingCostReport(c, scrPayload(rows(add), FROM, TO, '2026-08-11T15:00:00Z'));
  assert.equal(v.status, 'partially_accepted');
  assert.deepEqual(v.heldDates, ['2026-08-06']);
  const gap = await FT.uploadShippingCostReport(c, scrPayload(rows([['2026-08-24', '900301', '6.00']]), '2026-08-24', '2026-08-30'));
  assert.ok(gap.reviewReasons.includes('coverage_gap'));
  const early = await FT.uploadShippingCostReport(c, scrPayload(rows([['2026-08-10', '900302', '6.00']]), '2026-08-10', '2026-08-16', '2026-08-16T20:00:00Z'));
  assert.ok(early.reviewReasons.includes('possible_incomplete_trailing_date'));
});

test('privacy: a customer column in a Shopify segment rejects the whole source; nothing is retained and only a code is returned', async () => {
  const env = await freeTierEnv(), c = client(env);
  const good = prepareShopifyUpload(csvOrder({ name: '#900401', createdAt: '2026-08-04 10:00:00 -0700', subtotal: 10, total: 10, lines: [{ sku: 'MG-ALOE', price: 10 }] }).map(r => ({ ...r, 'Fulfilled at': '' })));
  const rows = FT.segmentCsv(good.text).rows.map(r => ({ ...r, Email: 'someone@example.test' }));
  const text = toCsvText(rows, Object.keys(rows[0]));
  await assert.rejects(FT.uploadSource(c, { kind: 'shopify', text, window: { from: '2026-08-03', to: '2026-08-09' } }), e => e.code === 'customer_data_rejected');
  const kept = await env.DB.prepare("SELECT status, error FROM src_object").first();
  assert.deepEqual([kept.status, kept.error], ['rejected', 'customer_data_rejected']);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM src_segment').first()).n, 0);
  assert.ok(!JSON.stringify(await env.DB.prepare('SELECT * FROM src_object').all()).includes('example.test'));
});

test('privacy: an SCR segment with the Recipient column, a decompression bomb or a wrong hash is refused', async () => {
  const env = await freeTierEnv(), c = client(env);
  const raw = rows(WEEK1);
  const withRecipient = toCsvText(raw, Object.keys(raw[0]));                    // 18 raw columns incl. Recipient
  await assert.rejects(FT.uploadSource(c, { kind: 'shipping_cost_report', text: withRecipient, window: { from: FROM, to: TO }, cents: 3290 }), e => e.code === 'unapproved_columns');
  // A tiny gzip that expands past the cap.
  const bomb = zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024, 0x41), { level: 9 });
  const sha = crypto.createHash('sha256').update(bomb).digest('hex');
  const listHash = crypto.createHash('sha256').update(sha).digest('hex');
  const open = await c.call('POST', '/v1/collect/sources', { json: { kind: 'shopify', sha256: listHash, rows: 1, window: { from: FROM, to: TO }, segments: [{ sha256: sha, rows: 1 }] } });
  await assert.rejects(c.call('PUT', `/v1/collect/sources/${open.sourceId}/segments/0`, { bytes: bomb }), e => e.code === 'decompressed_too_large' || e.code === 'compressed_too_large');
  const g = zlib.gzipSync(Buffer.from('Name\n#1\n'));
  const o2 = await c.call('POST', '/v1/collect/sources', { json: { kind: 'shopify', sha256: crypto.createHash('sha256').update('0'.repeat(64)).digest('hex'), rows: 1, window: { from: FROM, to: TO }, segments: [{ sha256: '0'.repeat(64), rows: 1 }] } });
  await assert.rejects(c.call('PUT', `/v1/collect/sources/${o2.sourceId}/segments/0`, { bytes: g }), e => e.code === 'hash_mismatch');
});

test('orders and results: non-canonical orders, unretained sources, forged manifests, other engines, bad parts and changed inputs are refused', async () => {
  const d = dataset({ n: 80 });
  const ft = await freeTierRun(d, { verify: false });
  const { env, c } = ft;
  const src = (await env.DB.prepare("SELECT source_id FROM src_object WHERE kind = 'shopify'").first()).source_id;
  const body = JSON.parse([...ft.orders.bodies.values()][0]);
  const loose = JSON.stringify({ lines: body.lines, ...body }), h = crypto.createHash('sha256').update(loose).digest('hex');   // not the canonical key order
  await assert.rejects(c.call('POST', '/v1/collect/orders', { json: { sourceId: src, orders: [{ s: loose, h }] } }), e => e.code === 'not_canonical');
  const s = orderBodyString(body), hs = crypto.createHash('sha256').update(s).digest('hex');
  await assert.rejects(c.call('POST', '/v1/collect/orders', { json: { sourceId: 'src_00000000000000000000', orders: [{ s, h: hs }] } }), e => e.code === 'source_not_retained');
  const week = d.weeks[d.weeks.length - 1];
  assert.ok((await c.call('GET', `/v1/collect/weeks/${week}/manifest`)).shortcut, 'recorded at finalize: answered without assembling');
  await env.DB.prepare('DELETE FROM manifest_check').run();
  const m = await c.call('GET', `/v1/collect/weeks/${week}/manifest`);
  assert.ok(m.existing, 'unchanged inputs: the manifest says the week is already computed');
  const forged = { ...m.manifest, previousShippingExpense: 1 };
  const fh = crypto.createHash('sha256').update(stableStringify(forged)).digest('hex');
  await assert.rejects(c.call('POST', `/v1/collect/weeks/${week}/results`, { json: { manifest: forged, manifestHash: fh, epoch: m.epoch, signature: m.signature, index: {} } }), e => e.code === 'manifest_not_issued');
  await assert.rejects(c.call('POST', `/v1/collect/weeks/${week}/results`, { json: { manifest: m.manifest, manifestHash: m.manifestHash, epoch: m.epoch, signature: m.signature, index: { engineVersion: '1999.01.01' } } }), e => e.code === 'engine_version_mismatch');
  // Inputs change between open and finalize → the result is refused and the upload abandoned.
  const snap = await FT.computeFromManifest(c, m.manifest, ft.cache);
  const { resultParts } = await import('../../shared/resultParts.js');
  const { ENGINE_VERSION } = await import('../../shared/snapshot.js');
  const r = resultParts(snap, ENGINE_VERSION);
  const sha = x => crypto.createHash('sha256').update(x).digest('hex');
  const index = { engineVersion: ENGINE_VERSION, parts: Object.fromEntries(Object.entries(r.parts).map(([k, v]) => [k, sha(v)])), orders: r.orderStrings.map(([n, v]) => [n, sha(v)]),
                  head: r.head, totals: r.totals, narrative: r.narrative, gateInputs: r.gateInputs };
  const open = await c.call('POST', `/v1/collect/weeks/${week}/results`, { json: { manifest: m.manifest, manifestHash: m.manifestHash, epoch: m.epoch, signature: m.signature, index } });
  // A part with an extra column is refused.
  const bad = JSON.parse(r.parts['orders:0']); bad.orders[0].email = 'x';
  const badText = stableStringify(bad);
  const idx2 = { ...index, parts: { ...index.parts, 'orders:0': sha(badText) } };
  const open2 = await c.call('POST', `/v1/collect/weeks/${week}/results`, { json: { manifest: m.manifest, manifestHash: m.manifestHash, epoch: m.epoch, signature: m.signature, index: idx2 } });
  await assert.rejects(c.call('PUT', `/v1/collect/results/${open2.snapshotId}/parts/orders:0`, { bytes: zlib.gzipSync(badText) }), e => e.code === 'part_invalid');
  for (const n of open.missing) await c.call('PUT', `/v1/collect/results/${open.snapshotId}/parts/${n}`, { bytes: zlib.gzipSync(r.parts[n]) });
  await ok(api(env, 'POST', '/v1/admin/settings', { mcg_free_shipping_threshold: 90, reason: 'test: settings changed mid-run' }), 'settings');
  await assert.rejects(c.call('POST', `/v1/collect/results/${open.snapshotId}/finalize`, { json: {} }), e => e.code === 'inputs_changed');
  assert.equal((await env.DB.prepare('SELECT status FROM result_upload WHERE snapshot_id = ?1').bind(open.snapshotId).first()).status, 'abandoned');
});

test('retries: repeating every upload and every week computes nothing and writes 0 rows', async () => {
  const d = dataset({ n: 120 });
  const ft = await freeTierRun(d, { verify: false });
  const { env, c } = ft;
  const before = changes(env);
  const s = await FT.uploadShippingCostReport(c, d.scr);
  const o = await FT.uploadShopifyOrders(c, d.shopify);
  const again = [];
  for (const w of d.weeks) again.push(await FT.computeAndUploadWeek(c, w, ft.cache));
  assert.equal(s.sourceStatus, 'already_have');
  assert.equal(o.written, 0);
  assert.ok(again.every(r => r.status === 'unchanged'), JSON.stringify(again));
  // Finalize recorded each week's check (migration 0021): a repeat writes 0 rows ...
  assert.equal(changes(env), before, '0 rows written');
  // ... and assembles no manifest (the shortcut answers), as does every further repeat.
  const mid = changes(env);
  let assembled = 0; const orig = env.DB.prepare.bind(env.DB);
  env.DB.prepare = sql => { if (/FROM ord_ptr WHERE week_start/.test(sql)) assembled++; return orig(sql); };
  const third = [];
  for (const w of d.weeks) third.push(await FT.computeAndUploadWeek(c, w, ft.cache));
  env.DB.prepare = orig;
  assert.ok(third.every(r => r.status === 'unchanged'));
  assert.equal(changes(env), mid, '0 rows written');
  assert.equal(assembled, 0, 'no manifest assembled');
  // Any input write (here a setting) moves the epoch: the next check assembles the manifest again.
  await api(env, 'POST', '/v1/admin/settings', { mcg_free_shipping_threshold: 77, reason: 'test: an input changed' });
  env.DB.prepare = sql => { if (/FROM ord_ptr WHERE week_start/.test(sql)) assembled++; return orig(sql); };
  await FT.computeAndUploadWeek(c, d.weeks[0], ft.cache);
  env.DB.prepare = orig;
  assert.ok(assembled > 0, 'a moved epoch re-checks');
});

test('verifier: an altered order GP or vendor total is a mismatch; the exact difference is stored privately; the public answer and logs carry counts only', async () => {
  const d = dataset({ n: 120 });
  const ft = await freeTierRun(d, { verify: false });
  const env = ft.env, snap = ft.results[ft.results.length - 1];
  const names = [...new Set((await env.DB.prepare('SELECT order_name FROM ord_ptr').all()).results.map(r => r.order_name))];
  const read = async part => JSON.parse(zlib.gunzipSync(Buffer.from((await env.DB.prepare('SELECT body FROM snapshot_blob WHERE snapshot_id = ?1 AND part = ?2').bind(snap.snapshotId, part).first()).body)).toString());
  const write = async (part, v) => env.DB.prepare('UPDATE snapshot_blob SET body = ?3 WHERE snapshot_id = ?1 AND part = ?2').bind(snap.snapshotId, part, zlib.gzipSync(stableStringify(v))).run();
  // 1. One order's GP + $0.01
  const chunk = await read('orders:0'); const original = stableStringify(chunk);
  const victim = chunk.orders[3]; const was = victim.operating_gp; victim.operating_gp = Math.round((was + 0.01) * 100) / 100;
  await write('orders:0', chunk);
  const logs = [];
  const v1 = await runVerifier(env, snap.snapshotId, logs);
  assert.equal(v1.body.status, 'mismatch');
  assert.ok(v1.body.orderMismatches >= 1 && v1.body.sectionMismatches >= 1);
  const pub = JSON.stringify(v1.body) + logs.join('\n');
  for (const k of Object.keys(v1.body)) assert.ok([...PUBLIC_KEYS, 'recorded', 'recordError', 'totalMs'].includes(k), k);
  for (const n of names) assert.ok(!pub.includes(n) && !pub.includes(n.replace('#', '')), 'no order name or number in the public answer or logs');
  for (const w of ['operating_gp', 'known_cost_gp', 'stored', 'recomputed', String(was)]) assert.ok(!pub.includes(w), `no field or amount (${w})`);
  const rep = await env.DB.prepare('SELECT status, diff FROM verify_report WHERE snapshot_id = ?1').bind(snap.snapshotId).first();
  const diff = JSON.parse(rep.diff);
  const hit = diff.orders.find(x => x.order === victim.order_name && x.field === 'order.operating_gp');
  assert.deepEqual([hit.stored, hit.recomputed, hit.deltaCents], [victim.operating_gp, was, -1]);
  const view = (await api(env, 'GET', `/v1/snapshot/${snap.weekStart}?includeDrafts=1`)).json.verification;
  assert.equal(view.status, 'mismatch');
  assert.ok(view.differences.orders.length >= 1, 'the logged-in dashboard sees the exact differences');
  // 2. Restore, then one vendor breakdown cell − $1.00
  await env.DB.prepare('UPDATE snapshot_blob SET body = ?3 WHERE snapshot_id = ?1 AND part = ?2').bind(snap.snapshotId, 'orders:0', zlib.gzipSync(original)).run();
  const sec = await read('sections');
  const cell = sec.breakdowns.find(b => b.dimension === 'vendor'); const before = cell.known_cost_gp; cell.known_cost_gp = Math.round((before - 1) * 100) / 100;
  await write('sections', sec);
  const v2 = await runVerifier(env, snap.snapshotId);
  assert.deepEqual([v2.body.status, v2.body.orderMismatches, v2.body.sectionMismatches], ['mismatch', 0, 1]);
  const d2 = JSON.parse((await env.DB.prepare('SELECT diff FROM verify_report WHERE snapshot_id = ?1').bind(snap.snapshotId).first()).diff);
  assert.ok(d2.sections.some(x => /^sections\.breakdowns\[\d+\]\.known_cost_gp$/.test(x.field) && x.stored === cell.known_cost_gp && x.recomputed === before));
  // 3. An order body altered in D1 (inputs no longer match the manifest) is caught too.
  await env.DB.prepare('UPDATE snapshot_blob SET body = ?3 WHERE snapshot_id = ?1 AND part = ?2').bind(snap.snapshotId, 'sections', zlib.gzipSync(stableStringify({ ...sec, breakdowns: sec.breakdowns.map(b => (b === cell ? { ...b, known_cost_gp: before } : b)) }))).run();
  assert.equal((await runVerifier(env, snap.snapshotId)).body.status, 'verified');
  const one = (await env.DB.prepare('SELECT body_hash, body FROM ord_body LIMIT 1').first());
  await env.DB.prepare('UPDATE ord_body SET body = ?2 WHERE body_hash = ?1').bind(one.body_hash, one.body.replace(/"subtotal":([\d.]+)/, (m, x) => `"subtotal":${Number(x) + 1}`)).run();
  const affected = (await env.DB.prepare('SELECT week_start FROM ord_ptr WHERE body_hash = ?1').bind(one.body_hash).first()).week_start;
  const snapFor = ft.results.find(r => r.weekStart === affected);
  const v3 = await runVerifier(env, snapFor.snapshotId);
  assert.equal(v3.body.status, 'mismatch');
  assert.equal(v3.body.reason, 'inputs_integrity');
});

test('week status names exactly what is pending; the target is never claimed without a verified draft; publication needs verification', async () => {
  const d = dataset({ n: 120 });
  const env = await freeTierEnv();
  const week = d.weeks[d.weeks.length - 1];
  const st = async () => (await api(env, 'GET', `/v1/weeks/${week}/status`)).json;
  let s = await st();
  assert.deepEqual(s.pending.map(p => p.code), ['shopify_export_pending', 'shipping_report_missing']);
  assert.equal(s.target, 'missed');                                 // a 2020 week: its 15:30 ICT slot has passed
  const ft = await freeTierRun(d, { verify: false });
  const env2 = ft.env;
  s = (await api(env2, 'GET', `/v1/weeks/${week}/status`)).json;
  assert.equal(s.state, 'verification_pending');
  assert.notEqual(s.target, 'met');
  const snapId = ft.results.find(r => r.weekStart === week).snapshotId;
  const pub = await api(env2, 'POST', '/v1/admin/publish', { snapshotId: snapId, reason: 'test' });
  assert.equal(pub.status, 409);
  assert.equal(pub.json.detail?.reason, 'verification_pending');
  await runVerifier(env2, snapId);
  s = (await api(env2, 'GET', `/v1/weeks/${week}/status`)).json;
  assert.deepEqual([s.state, s.target, s.verification.status], ['verified', 'met_late', 'verified']);
  const pub2 = await api(env2, 'POST', '/v1/admin/publish', { snapshotId: snapId, reason: 'test' });
  assert.equal(pub2.status, 409);
  assert.notEqual(pub2.json.detail?.reason, 'verification_pending', 'verification no longer blocks; the other controls still do');
  assert.ok(await bridge(env2)(`${ORIGIN}/v1/health`));
});

test('duplicate deliveries: the same source manifest and the same report version sent twice at once keep one of each', async () => {
  const env = await freeTierEnv(), c = client(env);
  const p = scrPayload(rows(WEEK1), FROM, TO);
  const { segmentCsv } = FT;
  const { segments, rows: r } = segmentCsv(p.text);
  const listHash = crypto.createHash('sha256').update(segments.map(s => s.sha256).join('\n')).digest('hex');
  const body = { kind: 'shipping_cost_report', sha256: listHash, rows: r.length, cents: 3290, window: { from: FROM, to: TO }, segments: segments.map(s => ({ sha256: s.sha256, rows: s.rows })) };
  const [a, b] = await Promise.all([c.call('POST', '/v1/collect/sources', { json: body }), c.call('POST', '/v1/collect/sources', { json: body })]);
  assert.equal(a.sourceId, b.sourceId);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM src_object').first()).n, 1);
  for (const seq of a.missing) await c.call('PUT', `/v1/collect/sources/${a.sourceId}/segments/${seq}`, { bytes: segments[seq].bytes });
  await c.call('POST', `/v1/collect/sources/${a.sourceId}/seal`, { json: {} });
  const { versionDays } = await import('../../shared/scrDays.js');
  const { parseShippingCostReport } = await import('../../shared/adapters/shippingCostReport.js');
  const { parseCSV } = await import('../../shared/calculator.js');
  const days = (await versionDays(parseShippingCostReport(parseCSV(p.text), { requestedFrom: FROM, requestedTo: TO }).rows, FROM, TO)).map(d => [d.date, d.groups]);
  const vb = { sourceId: a.sourceId, requestedFrom: FROM, requestedTo: TO, exportedAt: p.exportedAt, days };
  const [v1, v2] = await Promise.all([c.call('POST', '/v1/collect/scr/versions', { json: vb }), c.call('POST', '/v1/collect/scr/versions', { json: vb })]);
  assert.equal(v1.versionId, v2.versionId);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM scr_version').first()).n, 1);
});

test('unchanged-week checks: a result or publication re-checks only the weeks whose manifest reads it', async () => {
  const d = dataset({ n: 120 });
  const ft = await freeTierRun(d, { verify: false });
  const { env, c } = ft;
  const short = async w => !!(await c.call('GET', `/v1/collect/weeks/${w}/manifest`)).shortcut;
  for (const w of d.weeks) assert.equal(await short(w), true, `${w}: recorded when its result was finalized`);
  // A published revision changed outside the publish path (here directly): weeks 3 (its own published revision)
  // and 4 (its comparison) are checked again; every other week is still answered without assembling.
  const w3 = d.weeks[3];
  await env.DB.prepare("UPDATE snapshot SET status = 'published' WHERE week_start = ?1").bind(w3).run();
  const after = [];
  for (const w of d.weeks) after.push(await short(w));
  assert.deepEqual(after, d.weeks.map((w, i) => !(i === 3 || i === 4)));
  // Re-assembled: week 3 is still unchanged (recorded again, answered without assembling next time); week 4's
  // comparison changed, so it is no longer "existing" (it needs its recompute) and is never answered from a check.
  const again = [];
  for (const w of d.weeks) again.push(await short(w));
  assert.deepEqual(again, d.weeks.map((w, i) => i !== 4));
  assert.equal((await c.call('GET', `/v1/collect/weeks/${d.weeks[4]}/manifest`)).existing, null);
});
