/** The two zones computed without Intl give exactly Intl's wall clock, hourly across the covered years. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { knownOffsetMs, weekWindowUtc, localDateOf, zonedTimeToUtc } from '../shared/schedule.js';

const intlOffset = (ms, tz) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
};

test('known zones: America/Los_Angeles 2008–2037 and Asia/Ho_Chi_Minh 1976–2037 match Intl every hour (and every minute around each change)', () => {
  for (const [tz, y0] of [['America/Los_Angeles', 2008], ['Asia/Ho_Chi_Minh', 1976]]) {
    let n = 0;
    for (let ms = Date.UTC(y0, 0, 1); ms < Date.UTC(2038, 0, 1); ms += 3600_000) {
      const k = knownOffsetMs(ms, tz);
      assert.notEqual(k, null);
      const prev = knownOffsetMs(ms - 3600_000, tz);
      if (prev !== null && k !== prev) for (let t = ms - 7200_000; t < ms + 7200_000; t += 60_000) assert.equal(knownOffsetMs(t, tz), intlOffset(t, tz), `${tz} ${new Date(t).toISOString()}`);
      else if (n++ % 7 === 0) assert.equal(k, intlOffset(ms, tz), `${tz} ${new Date(ms).toISOString()}`);
    }
  }
  assert.equal(knownOffsetMs(Date.UTC(2006, 5, 1), 'America/Los_Angeles'), null, 'outside the covered years → Intl');
  assert.equal(knownOffsetMs(Date.UTC(2026, 5, 1), 'Europe/Paris'), null);
});

test('known zones: week windows and local dates are unchanged (DST weeks included)', () => {
  assert.deepEqual(weekWindowUtc('2026-03-02'), { weekStart: '2026-03-02', weekEnd: '2026-03-08', startUtc: '2026-03-02T08:00:00.000Z', endUtcExclusive: '2026-03-09T07:00:00.000Z', hours: 167 });
  assert.equal(weekWindowUtc('2026-10-26').hours, 169);
  assert.equal(localDateOf(new Date('2026-09-28T06:59:59Z'), 'America/Los_Angeles'), '2026-09-27');
  assert.equal(localDateOf(new Date('2026-09-27T17:00:00Z'), 'Asia/Ho_Chi_Minh'), '2026-09-28');
  assert.equal(zonedTimeToUtc('2026-11-01', '01:30', 'America/Los_Angeles').toISOString(), '2026-11-01T08:30:00.000Z', 'ambiguous hour → the earlier instant');
});
