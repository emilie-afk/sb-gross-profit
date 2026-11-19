/**
 * Free-tier path (second review, 2026-09-30): the publication gate is verified. The collector's gate
 * inputs must equal the verifier's recomputation, the stored gate decision must equal the gate
 * re-evaluated with them, and publication requires a report naming the hash of exactly that gate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { api, ok, dataset, freeTierRun, runVerifier } from './freeTierHarness.mjs';
import * as FT from '../../automation/collector/src/freeTier.mjs';
import { resultParts } from '../../shared/resultParts.js';
import { ENGINE_VERSION } from '../../shared/snapshot.js';
import { stableStringify } from '../../shared/normalized.js';

const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const EMAIL = { email: 'synthetic@example.invalid' };

/** Compute a week as the collector does, let `mutate` alter parts / index, upload; returns { open, r, index, m }. */
async function upload(ft, week, mutate = () => {}, { finalize = false } = {}) {
  const { c } = ft;
  await ok(api(ft.env, 'POST', '/v1/admin/settings', { shipping_coverage_aging_days: 13 + Math.floor(Math.random() * 60), reason: 'test: new revision' }), 'settings');
  const m = await c.call('GET', `/v1/collect/weeks/${week}/manifest`);
  const snap = await FT.computeFromManifest(c, m.manifest, ft.cache);
  const r = resultParts(snap, ENGINE_VERSION);
  const parts = { ...r.parts };
  const index = { engineVersion: ENGINE_VERSION, parts: {}, orders: r.orderStrings.map(([n, v]) => [n, sha(v)]), head: r.head, totals: r.totals, narrative: r.narrative, gateInputs: r.gateInputs };
  mutate({ parts, index, r });
  index.parts = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, sha(v)]));
  const open = await c.call('POST', `/v1/collect/weeks/${week}/results`, { json: { manifest: m.manifest, manifestHash: m.manifestHash, epoch: m.epoch, signature: m.signature, index } });
  const put = name => c.call('PUT', `/v1/collect/results/${open.snapshotId}/parts/${name}`, { bytes: zlib.gzipSync(parts[name]) });
  let f = null;
  if (finalize) { for (const n of open.missing) await put(n); f = await c.call('POST', `/v1/collect/results/${open.snapshotId}/finalize`, { json: {} }); }
  return { open, put, parts, index, f };
}

test('gate: fabricated reconciliation checks are a verification mismatch, and publication is refused', async () => {
  const d = dataset({ n: 80 });
  const ft = await freeTierRun(d, { verify: false });
  const week = d.weeks[7];
  const u = await upload(ft, week, ({ index }) => {
    index.gateInputs = { ...index.gateInputs, reconciliation: index.gateInputs.reconciliation.map(x => ({ ...x, passed: true, delta: 0, actual: x.expected })).concat([{ check: 'fabricated', passed: true, blocking: true }]) };
  }, { finalize: true });
  assert.match(u.f.snapshotId, /^snp_/, 'finalize itself cannot tell: the gate inputs come from the collector');
  const v = await runVerifier(ft.env, u.f.snapshotId);
  assert.equal(v.body.status, 'mismatch');
  assert.equal(v.body.gateInputsMatch, false);
  assert.equal(v.body.gateHash, undefined, 'no gate hash for an unverified gate');
  const diff = JSON.parse((await ft.env.DB.prepare('SELECT diff FROM verify_report WHERE snapshot_id = ?1').bind(u.f.snapshotId).first()).diff);
  assert.ok(diff.sections.some(x => x.field.startsWith('gateInputs.reconciliation')), 'the exact difference is stored privately');
  const pub = await api(ft.env, 'POST', '/v1/admin/publish', { snapshotId: u.f.snapshotId, reason: 'test' });
  assert.equal(pub.json.detail?.reason, 'verification_mismatch');
});

test('gate: the stored decision is re-evaluated; publication uses exactly the verified gate', async () => {
  const d = dataset({ n: 80 });
  const ft = await freeTierRun(d, { verify: false });
  const env = ft.env, week = d.weeks[7];
  const snap = ft.results.find(r => r.weekStart === week);
  // Honest draft: verified, with the hash of its gate; the verification no longer blocks publication.
  const v = await runVerifier(env, snap.snapshotId);
  assert.deepEqual([v.body.status, v.body.gateInputsMatch, v.body.gateMatches], ['verified', true, true]);
  assert.match(v.body.gateHash, /^[0-9a-f]{64}$/);
  const pub = await api(env, 'POST', '/v1/admin/publish', { snapshotId: snap.snapshotId, reason: 'test' });
  assert.ok(!/^verification_/.test(pub.json.detail?.reason || ''), `verification does not block (${pub.json.detail?.reason})`);
  // The gate record altered after verification (a failure removed): publication refuses it.
  const runId = (await env.DB.prepare('SELECT run_id FROM snapshot WHERE snapshot_id = ?1').bind(snap.snapshotId).first()).run_id;
  const g = JSON.parse((await env.DB.prepare('SELECT gate FROM reporting_run WHERE run_id = ?1').bind(runId).first()).gate);
  const forged = { ...g, passed: true, failures: [], warnings: [...g.warnings, { code: 'x', message: 'x' }] };
  await env.DB.prepare('UPDATE reporting_run SET gate = ?2 WHERE run_id = ?1').bind(runId, JSON.stringify(forged)).run();
  const pub2 = await api(env, 'POST', '/v1/admin/publish', { snapshotId: snap.snapshotId, reason: 'test' });
  assert.equal(pub2.json.detail?.reason, 'verification_gate_unchecked');
  // Re-verifying the forged record: the re-evaluated gate differs → mismatch.
  const v2 = await runVerifier(env, snap.snapshotId);
  assert.deepEqual([v2.body.status, v2.body.gateInputsMatch, v2.body.gateMatches], ['mismatch', true, false]);
  // A record without the Worker facts cannot be verified.
  const { ordersInOtherTimezone: _o, ...incomplete } = g;
  await env.DB.prepare('UPDATE reporting_run SET gate = ?2 WHERE run_id = ?1').bind(runId, JSON.stringify(incomplete)).run();
  assert.deepEqual([(await runVerifier(env, snap.snapshotId)).body.status, (await runVerifier(env, snap.snapshotId)).body.reason], ['unavailable', 'gate_record_incomplete']);
});
