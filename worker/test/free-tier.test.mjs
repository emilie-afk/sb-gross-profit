/**
 * Free-tier weekly path, end to end: the collector module, the Worker's /v1/collect and
 * /v1/verify routes and the gp-verify function, against today's Worker path as reference.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dataset, legacyRun, freeTierRun, dashboardView, mask, api } from './freeTierHarness.mjs';

for (const [label, opts] of [['DST start (2020-03-08)', {}], ['DST end (2020-11-01)', { lastWeek: '2020-11-23', prefix: '6' }]])
test(`Free-tier path, ${label}: dashboard results equal the Worker path for every week; every draft verified`, { timeout: 300_000 }, async () => {
  const d = dataset(opts);
  const ref = await legacyRun(d);
  const ft = await freeTierRun(d);
  assert.equal(ft.results.length, d.weeks.length);
  assert.ok(ft.results.every(r => r.status === 'computed'), JSON.stringify(ft.results));
  for (const v of ft.verified) {
    assert.equal(v.body.status, 'verified', JSON.stringify(v.body));
    assert.equal(v.body.orderMismatches, 0);
    assert.equal(v.body.provenanceMismatches, 0);
    assert.ok(v.body.provenanceChecked > 0);
  }
  for (const w of d.weeks) {
    const a = await dashboardView(ref, w), b = await dashboardView(ft.env, w);
    assert.equal(b.snap.revision, 1);
    for (const k of Object.keys(a)) assert.equal(mask(b[k]), mask(a[k]), `${w}: ${k}`);
  }
  const wk = (await api(ft.env, 'GET', '/v1/weeks?includeDrafts=1')).json.weeks;
  assert.ok(wk.every(x => x.revisions[0].verification === 'verified' && x.revisions[0].computedBy === 'collector'));
});
