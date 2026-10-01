/**
 * Free-tier path: a Shipping Cost Report version may send dates identical to their current owner
 * as the day hash alone, so the upload's work grows with the changed dates, not the window.
 * A hash that is not the owner's, or sums that do not reconcile, are refused.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { freeTierEnv, api, ok, client, scrPayload } from './freeTierHarness.mjs';
import * as FT from '../../automation/collector/src/freeTier.mjs';
import { reportRow } from '../../tests/fixtures-shipping-cost.mjs';
import { versionDays } from '../../shared/scrDays.js';
import { parseShippingCostReport } from '../../shared/adapters/shippingCostReport.js';
import { parseCSV } from '../../shared/calculator.js';

const FROM = '2026-08-03', TO = '2026-08-09';
const rows = list => list.map(([date, order, cost]) => reportRow({ date, order, cost, paid: '5.00' }));
const WEEK1 = [['2026-08-03', '900101', '6.25'], ['2026-08-04', '900102', '7.10'], ['2026-08-05', '900103', '5.55'], ['2026-08-06', '900104', '8.00'], ['2026-08-07', '900105', '6.00']];

test('SCR owners: unchanged dates go as hashes; the outcome is the same; a wrong hash or wrong sums are refused', async () => {
  const env = await freeTierEnv(), c = client(env);
  const v1 = await FT.uploadShippingCostReport(c, scrPayload(rows(WEEK1), FROM, TO));
  await ok(api(env, 'POST', `/v1/admin/scr/versions/${v1.versionId}/accept`, { reason: 'test: first version reviewed' }), 'accept');
  const owners = new Map((await c.call('POST', '/v1/collect/scr/owners', { json: { from: FROM, to: TO } })).owners);
  assert.equal(owners.size, 7);
  // The collector sends every unchanged date as its hash: identical re-export → no_change.
  const sent = [];
  const realCall = c.call;
  c.call = async (m, p, o) => { if (p === '/v1/collect/scr/versions') sent.push(o.json.days); return realCall(m, p, o); };
  const changed = WEEK1.map(r => (r[1] === '900103' ? [r[0], r[1], '5.95'] : r));
  const v2 = await FT.uploadShippingCostReport(c, scrPayload(rows(changed), FROM, TO, '2026-08-11T15:00:00Z'));
  c.call = realCall;
  assert.equal(sent[0].filter(d => d[1] === null).length, 6, 'six unchanged dates as hashes');
  assert.deepEqual(sent[0].filter(d => d[1] !== null).map(d => d[0]), ['2026-08-05'], 'only the changed date carries groups');
  assert.deepEqual([v2.status, v2.counts], ['pending_review', { new: 0, identical: 6, fill_in: 0, held: 1 }]);

  // Direct: a hash that is not the owner's is refused; so are sums that do not reconcile with the segments.
  const p3 = scrPayload(rows([...changed].reverse()), FROM, TO, '2026-08-12T15:00:00Z');      // another file (a new source)
  const parsed = parseShippingCostReport(parseCSV(p3.text), { requestedFrom: FROM, requestedTo: TO });
  const src = await FT.uploadSource(c, { kind: 'shipping_cost_report', text: p3.text, window: { from: FROM, to: TO }, exportedAt: p3.exportedAt, cents: parsed.shippingCostCents });
  const days = await versionDays(parsed.rows, FROM, TO);
  const body = ds => ({ json: { sourceId: src.sourceId, requestedFrom: FROM, requestedTo: TO, exportedAt: p3.exportedAt, days: ds } });
  const lie = days.map(d => [d.date, null, owners.get(d.date)]);                       // claims 08-05 unchanged, but its sums differ
  await assert.rejects(c.call('POST', '/v1/collect/scr/versions', body(lie)), e => e.code === 'groups_mismatch');
  const bad = days.map(d => (d.date === '2026-08-04' ? [d.date, null, 'f'.repeat(64)] : [d.date, d.groups]));
  await assert.rejects(c.call('POST', '/v1/collect/scr/versions', body(bad)), e => e.code === 'day_hash_unknown');
  await assert.rejects(c.call('POST', '/v1/collect/scr/owners', { json: { from: FROM, to: '2027-01-01' } }), e => e.code === 'bad_payload');
});
