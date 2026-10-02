/** GET /v1/collect/verification: ingest credential only, 1–16 well-formed ids, unknown ids answered as unknown. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freeTierEnv, api } from './freeTierHarness.mjs';

test('verification statuses route: auth, id validation, unknown ids', async () => {
  const env = await freeTierEnv();
  const id = 'snp_' + '0'.repeat(20);
  const r = await api(env, 'GET', `/v1/collect/verification?ids=${id}`, undefined, 'ingest');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.snapshots, [{ snapshotId: id, unknown: true }]);
  for (const q of ['', '?ids=', '?ids=snp_x', `?ids=${Array(17).fill(id).join(',')}`]) {
    assert.equal((await api(env, 'GET', `/v1/collect/verification${q}`, undefined, 'ingest')).status, 400, q);
  }
  assert.notEqual((await api(env, 'GET', `/v1/collect/verification?ids=${id}`)).status, 200);
});
