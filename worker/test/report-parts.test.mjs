/**
 * GET /v1/snapshot/:week/report-parts (2026-11-20): several stored parts in one response, equal to the single
 * report-part answers; bounded, pinned to a revision, readers only. Synthetic Free-tier dataset.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dataset, freeTierRun, api } from './freeTierHarness.mjs';
import * as SR from '../../js/storedReport.js';

const Q = '?includeDrafts=1';
let run, weeks;
test('setup: stored weeks', { timeout: 300_000 }, async () => {
  run = await freeTierRun(dataset({ n: 360 }), { verify: false });
  weeks = [];
  for (const r of run.results.filter(x => x.status === 'computed')) {
    const head = (await api(run.env, 'GET', `/v1/snapshot/${r.weekStart}${Q}`)).json;
    const parts = [];
    for (let k = 0; ; k++) {
      const p = (await api(run.env, 'GET', `/v1/snapshot/${r.weekStart}/report-part/${k}${Q}&snapshot=${head.snapshotId}`)).json;
      parts.push(p); if (k + 1 >= p.parts) break;
    }
    weeks.push({ weekStart: r.weekStart, head, parts });
  }
  assert.ok(weeks.length >= 2 && weeks.some(w => w.parts.length >= 2));
});

test('report-parts: the same rows as the single parts, in order, in fewer requests', async () => {
  for (const w of weeks) {
    const got = [];
    for (let from = 0; from < w.parts.length; from += 3) {
      const r = await api(run.env, 'GET', `/v1/snapshot/${w.weekStart}/report-parts${Q}&from=${from}&count=3&snapshot=${w.head.snapshotId}`);
      assert.equal(r.status, 200, r.text);
      assert.deepEqual([r.json.snapshotId, r.json.parts, r.json.from, r.json.revision], [w.head.snapshotId, w.parts.length, from, w.head.revision]);
      got.push(...r.json.items);
    }
    assert.deepEqual(got.map(i => i.part), w.parts.map((_, k) => k));
    got.forEach((it, k) => {
      assert.deepEqual(it.o, w.parts[k].o, `orders of part ${k}`);
      assert.deepEqual(it.l, w.parts[k].l, `lines of part ${k}`);
      assert.deepEqual(it.skuVendors, w.parts[k].skuVendors);
    });
  }
});

test('report-parts: bounded, pinned, unknown part, readers only', async () => {
  const w = weeks[0], env = run.env;
  for (const bad of ['from=-1', 'count=0', 'count=9', 'from=x', 'count=1.5']) {
    assert.equal((await api(env, 'GET', `/v1/snapshot/${w.weekStart}/report-parts${Q}&${bad}`)).status, 400, bad);
  }
  const stale = await api(env, 'GET', `/v1/snapshot/${w.weekStart}/report-parts${Q}&snapshot=snp_00000000000000000000`);
  assert.deepEqual([stale.status, stale.json.error], [409, 'snapshot_changed']);
  const beyond = await api(env, 'GET', `/v1/snapshot/${w.weekStart}/report-parts${Q}&from=${w.parts.length}`);
  assert.deepEqual([beyond.status, beyond.json.error], [404, 'part_unknown']);
  const tail = await api(env, 'GET', `/v1/snapshot/${w.weekStart}/report-parts${Q}&from=${w.parts.length - 1}&count=8`);
  assert.deepEqual(tail.json.items.map(i => i.part), [w.parts.length - 1], 'parts past the last are left out');
  assert.equal((await api(env, 'GET', `/v1/snapshot/${w.weekStart}/report-parts`, undefined, 'none')).status, 401);
  const noDrafts = await api(env, 'GET', `/v1/snapshot/${w.weekStart}/report-parts`);
  assert.deepEqual([noDrafts.status, noDrafts.json.error], [404, 'week_unknown']);
});

test('the dashboard loader with the real route: same weeks as single parts', async () => {
  const env = run.env;
  const plan = SR.periodPlan('range', `${weeks[0].weekStart}_${SR.addDays(weeks[weeks.length - 1].weekStart, 6)}`,
    weeks.map(w => ({ weekStart: w.weekStart, revisions: [{ revision: w.head.revision, status: 'published', snapshotId: w.head.snapshotId }] })), { earliest: '2000-01-03' });
  let single = 0, bundled = 0;
  const base = { snapshot: async week => (await api(env, 'GET', `/v1/snapshot/${week}${Q}`)).json,
                 reportPart: async (week, k, id) => { single++; return (await api(env, 'GET', `/v1/snapshot/${week}/report-part/${k}${Q}&snapshot=${id}`)).json; } };
  const a = await SR.loadPeriod(base, plan);
  const viaRoute = { ...base, reportParts: async (week, from, count, id) => { bundled++; return (await api(env, 'GET', `/v1/snapshot/${week}/report-parts${Q}&from=${from}&count=${count}&snapshot=${id}`)).json; } };
  const n = single;
  const b = await SR.loadPeriod(viaRoute, plan);
  assert.equal(single, n);
  assert.ok(bundled <= weeks.length * Math.ceil(Math.max(...weeks.map(w => w.parts.length)) / 8));
  assert.deepEqual(b.weeks.map(w => [w.orders, w.lines, w.skuVendors]), a.weeks.map(w => [w.orders, w.lines, w.skuVendors]));
});
