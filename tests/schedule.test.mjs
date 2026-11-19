/**
 * Revision 6: Monday 15:30 Asia/Ho_Chi_Minh automation schedule vs the
 * Monday–Sunday America/Los_Angeles reporting week, across daylight saving.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planCycle, weekWindowUtc, scheduledRunFor, lastClosedWeek, zonedTimeToUtc, localDateOf, DEFAULT_SCHEDULE }
  from '../shared/schedule.js';
import { addDays } from '../shared/normalized.js';
import { lastCompletedWeek } from '../automation/shipstation-export/src/lib.mjs';

const hmIn = (d, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);

test('the agreed schedule is Monday 15:30 in Ho Chi Minh, not 3:30 AM and not Pacific', () => {
  assert.deepEqual({ ...DEFAULT_SCHEDULE }, { timeZone: 'Asia/Ho_Chi_Minh', weekday: 1, time: '15:30' });
  const due = scheduledRunFor('2026-09-14');
  assert.equal(due.toISOString(), '2026-09-21T08:30:00.000Z');
  assert.equal(hmIn(due, 'Asia/Ho_Chi_Minh'), 'Mon 15:30');
});

for (const [label, weekStart, startUtc, endUtc, hours, storeLocalAtRun] of [
  ['ordinary summer week',           '2026-09-14', '2026-09-14T07:00:00.000Z', '2026-09-21T07:00:00.000Z', 168, 'Mon 01:30'],
  ['week containing spring-forward',  '2026-03-02', '2026-03-02T08:00:00.000Z', '2026-03-09T07:00:00.000Z', 167, 'Mon 01:30'],
  ['first week after spring-forward', '2026-03-09', '2026-03-09T07:00:00.000Z', '2026-03-16T07:00:00.000Z', 168, 'Mon 01:30'],
  ['week containing fall-back',       '2026-10-26', '2026-10-26T07:00:00.000Z', '2026-11-02T08:00:00.000Z', 169, 'Mon 00:30'],
  ['first week after fall-back',      '2026-11-02', '2026-11-02T08:00:00.000Z', '2026-11-09T08:00:00.000Z', 168, 'Mon 00:30'],
  ['2027 spring-forward week',        '2027-03-08', '2027-03-08T08:00:00.000Z', '2027-03-15T07:00:00.000Z', 167, 'Mon 01:30'],
  ['2027 fall-back week',             '2027-11-01', '2027-11-01T07:00:00.000Z', '2027-11-08T08:00:00.000Z', 169, 'Mon 00:30'],
]) {
  test(`reporting week boundaries and the Monday 15:30 run: ${label}`, () => {
    const w = weekWindowUtc(weekStart);
    assert.deepEqual([w.startUtc, w.endUtcExclusive, w.hours], [startUtc, endUtc, hours]);
    const due = scheduledRunFor(weekStart);
    assert.equal(hmIn(due, 'Asia/Ho_Chi_Minh'), 'Mon 15:30');
    assert.equal(localDateOf(due, 'Asia/Ho_Chi_Minh'), addDays(weekStart, 7));
    assert.equal(hmIn(due, 'America/Los_Angeles'), storeLocalAtRun);          // the week has closed in the store zone
    assert.ok(due >= new Date(endUtc));
    const plan = planCycle(due);
    assert.deepEqual([plan.weekStart, plan.weekEnd, plan.due], [weekStart, addDays(weekStart, 6), true]);
    assert.equal(planCycle(new Date(due.getTime() - 60_000)).due, false);    // one minute early is not due
    assert.equal(plan.shopify.weekQuery, `created_at:>='${startUtc.replace('.000', '')}' AND created_at:<'${endUtc.replace('.000', '')}'`);
    assert.equal(plan.shopify.updatedQuery, `updated_at:>='${startUtc.replace('.000', '')}' AND created_at:<'${startUtc.replace('.000', '')}'`);
  });
}

test('every run from 2026 to 2028 covers the previous Monday–Sunday and never starts before it closes', () => {
  for (let w = '2025-12-29'; w < '2029-01-01'; w = addDays(w, 7)) {
    const { endUtcExclusive } = weekWindowUtc(w);
    const due = scheduledRunFor(w);
    assert.ok(due >= new Date(endUtcExclusive), w);
    assert.ok(due - new Date(endUtcExclusive) <= 2 * 3600_000, `${w}: run is within two hours of the close`);
    assert.equal(planCycle(due).weekStart, w);
  }
});

test('the week closes at store-local midnight, not UTC midnight', () => {
  assert.equal(lastClosedWeek(new Date('2026-11-02T07:59:00Z')), '2026-10-19');   // Sunday 23:59 PST
  assert.equal(lastClosedWeek(new Date('2026-11-02T08:00:00Z')), '2026-10-26');   // Monday 00:00 PST
  assert.equal(lastClosedWeek(new Date('2026-09-21T06:59:00Z')), '2026-09-07');   // Sunday 23:59 PDT
  assert.equal(lastClosedWeek(new Date('2026-09-21T07:00:00Z')), '2026-09-14');
});

test('an ambiguous fall-back time resolves to the earlier instant', () => {
  assert.equal(zonedTimeToUtc('2026-11-01', '01:30', 'America/Los_Angeles').toISOString(), '2026-11-01T08:30:00.000Z');
});

test('a Pacific 15:30 schedule would shift in UTC across DST — the reason the zone is explicit', () => {
  const pt = { timeZone: 'America/Los_Angeles', weekday: 1, time: '15:30' };
  assert.equal(scheduledRunFor('2026-10-19', pt).toISOString(), '2026-10-26T22:30:00.000Z');
  assert.equal(scheduledRunFor('2026-11-02', pt).toISOString(), '2026-11-09T23:30:00.000Z');
});

test('the Windows ShipStation job at Monday 15:05 Ho Chi Minh (08:05 UTC) exports the week that just closed', () => {
  for (const [at, week] of [['2026-09-21T08:05:00Z', '2026-09-14'], ['2026-11-02T08:05:00Z', '2026-10-26'],
                            ['2026-11-09T08:05:00Z', '2026-11-02'], ['2027-03-15T08:05:00Z', '2027-03-08'],
                            ['2026-03-09T08:05:00Z', '2026-03-02']]) {
    assert.equal(lastCompletedWeek(new Date(at), 'America/Los_Angeles').weekStart, week, at);
  }
});
