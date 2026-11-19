/** The Shopify export calendar is driven by day-button names; check the names it is matched with. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarDayLabel, calendarDayPattern } from '../automation/shopify-export/src/lib.mjs';

test('shopify calendar: day labels and matching (range/today prefixes allowed, other days not)', () => {
  assert.equal(calendarDayLabel('2026-08-03'), 'Monday August 3 2026');
  assert.equal(calendarDayLabel('2026-09-27'), 'Sunday September 27 2026');
  assert.equal(calendarDayLabel('2028-02-29'), 'Tuesday February 29 2028');
  const p = calendarDayPattern('2026-10-02');
  assert.ok(p.test('Friday October 2 2026') && p.test('End of range Today Friday October 2 2026'));
  assert.ok(!p.test('Monday October 12 2026') && !p.test('Friday October 2 20267'));
  assert.ok(!calendarDayPattern('2026-10-01').test('Saturday October 11 2026'));
  assert.throws(() => calendarDayLabel('10/02/2026'));
});
