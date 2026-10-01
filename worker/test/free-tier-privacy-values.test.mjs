/**
 * Free-tier path (second review, 2026-09-30): result values are typed. No object or array hides in
 * an allowed column, JSON-text columns are parsed and walked for customer fields, and no part
 * carries extra top-level data.
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

test('privacy: an object, array or customer field inside an allowed column is refused, and nothing is stored', async () => {
  const d = dataset({ n: 80 });
  const ft = await freeTierRun(d, { verify: false });
  const week = d.weeks[7];
  const cases = [
    ['orders:0', v => { v.orders[0].channel = EMAIL; }, 'part_invalid'],                                    // the review probe: an object in an allowed column
    ['orders:0', v => { v.orders[0].channel = ['synthetic@example.invalid']; }, 'part_invalid'],
    ['lines:0', v => { v.lines[0].product = EMAIL; }, 'part_invalid'],
    ['lines:0', v => { v.lines[0].flags = JSON.stringify({ isProductLine: true, customer: { email: 'synthetic@example.invalid' } }); }, 'customer_data_rejected'],
    ['lines:0', v => { v.lines[0].flags = 'not json'; }, 'part_invalid'],
    ['sections', v => { v.issues[0] = { ...v.issues[0], detail: JSON.stringify({ orderName: '#1', email: 'synthetic@example.invalid' }) }; }, 'customer_data_rejected'],
    ['sections', v => { v.extra = EMAIL; }, 'part_invalid'],
    ['sections', v => { v.shippingC3 = { ...(v.shippingC3 || {}), buyer: { email: 'synthetic@example.invalid' } }; }, 'customer_data_rejected'],
    ['scenario:0', v => { v.lines[0].sku = EMAIL; }, 'part_invalid'],
    ['scenario:0', v => { v.lines[0].isRoute = 'yes'; }, 'part_invalid'],
    ['orderindex', v => { v.orders[0][6] = EMAIL; }, 'part_invalid'],
    ['orders:0', v => { v.orders[0].operating_gp = { value: 1 }; }, 'part_invalid'],
  ];
  for (const [name, change, code] of cases) {
    const u = await upload(ft, week, ({ parts }) => { const v = JSON.parse(parts[name]); change(v); parts[name] = JSON.stringify(v); });
    await assert.rejects(u.put(name), e => e.code === code, `${name}: expected ${code}`);
    const stored = await ft.env.DB.prepare('SELECT COUNT(*) AS n FROM snapshot_blob WHERE snapshot_id = ?1 AND part = ?2').bind(u.open.snapshotId, name).first();
    assert.equal(stored.n, 0, `${name}: nothing stored`);
  }
  // The index head / totals are columns too.
  await assert.rejects(upload(ft, week, ({ index }) => { const t = JSON.parse(index.totals); t.labels = JSON.stringify({ contact: { email: 'synthetic@example.invalid' } }); index.totals = stableStringify(t); }),
    e => e.code === 'customer_data_rejected');
  await assert.rejects(upload(ft, week, ({ index }) => { index.head = { ...index.head, catalog_rev: EMAIL }; }), e => e.code === 'bad_payload');
});
