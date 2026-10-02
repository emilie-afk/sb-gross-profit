/**
 * The collector waits for verification with ONE light request per poll
 * (GET /v1/collect/verification?ids=…), and falls back to per-week status against an
 * older Worker that does not have that route.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { requestVerification, collectClient, WorkerCallError } from '../automation/collector/src/freeTier.mjs';

const A = 'snp_' + 'a'.repeat(20), B = 'snp_' + 'b'.repeat(20);
const snaps = [{ snapshotId: A, weekStart: '2026-09-20' }, { snapshotId: B, weekStart: '2026-09-27' }];
const verifier = async () => new Response(null, { status: 202 });

test('batched poll: one request per poll, statuses and superseded drafts resolved', async () => {
  const calls = []; let n = 0;
  const client = { call: async (m, p) => { calls.push(p); n++;
    return { snapshots: n === 1 ? [{ snapshotId: A, verification: null }, { snapshotId: B, verification: null }]
                                : [{ snapshotId: A, verification: 'verified' }, { snapshotId: B, verification: null, superseded: true }].filter(x => p.includes(x.snapshotId)) }; } };
  const r = await requestVerification({ verifyUrl: 'https://v.test/', triggerSecret: 't', snapshots: snaps, client, fetchImpl: verifier, sleep: async () => {} });
  assert.deepEqual(r.map(x => x.status), ['verified', 'superseded']);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(p => p.startsWith('/v1/collect/verification?ids=')));
  assert.ok(!calls.some(p => p.includes('/status')));
});

test('older Worker (404 on the batched route): falls back to per-week status', async () => {
  const calls = [];
  const client = { call: async (m, p) => { calls.push(p);
    if (p.startsWith('/v1/collect/verification')) throw new WorkerCallError(404, 'not_found');
    const s = snaps.find(x => p.includes(x.weekStart));
    return { draft: { snapshotId: s.snapshotId }, verification: { status: 'verified' } }; } };
  const r = await requestVerification({ verifyUrl: 'https://v.test/', triggerSecret: 't', snapshots: snaps, client, fetchImpl: verifier, sleep: async () => {} });
  assert.deepEqual(r.map(x => x.status), ['verified', 'verified']);
  assert.equal(calls.filter(p => p.startsWith('/v1/collect/verification')).length, 1);
});

test('the collect client sends the batched query path and still refuses other characters', async () => {
  const urls = [];
  const c = collectClient({ workerUrl: 'https://w.test', ingestSecret: 's', fetchImpl: async u => { urls.push(u); return Response.json({ snapshots: [] }); } });
  await c.call('GET', `/v1/collect/verification?ids=${A},${B}`);
  assert.equal(urls[0], `https://w.test/v1/collect/verification?ids=${A},${B}`);
  await assert.rejects(c.call('GET', '/v1/collect/verification?ids=<x>'), /unexpected collect path/);
  await assert.rejects(c.call('GET', '/v1/admin/settings'), /unexpected collect path/);
});
