/**
 * Why a week is not in a month or custom-date report (2026-11-20): the coverage gate in counts, other holds,
 * the first pending step, and ShipStation waiting for a person to sign in. Synthetic values only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { gapReason } from '../js/storedReport.js';
import { renderMonthList } from '../js/weeklyReports.js';

const held = { weekStart: '2026-11-09', revisions: [{ revision: 3, status: 'blocked', verification: 'verified',
  hold: [{ code: 'ss_coverage', message: 'ShipStation expense coverage 60.0% is below the 95% threshold' }],
  shippingCoverage: { ordersWithCost: 120, ordersRequiringCost: 200 } }] };
const pub = { weekStart: '2026-11-02', revisions: [{ revision: 2, status: 'published', verification: 'verified', hold: [] }] };
const gap = { from: '2026-11-09', to: '2026-11-15', weekStart: '2026-11-09', reason: 'not_published' };

test('gap reason: coverage gate in counts, threshold from the hold', () => {
  assert.equal(gapReason(gap, [held, pub]), 'shipping costs in for 120 of 200 orders (60%); publishes at 95%');
});

test('gap reason: ShipStation sign-in and the first pending step come from the week status', () => {
  const st = { pending: [], attention: { code: 'shipstation_signin_required' } };
  assert.equal(gapReason(gap, [held], st), 'shipping costs in for 120 of 200 orders (60%); publishes at 95% · waiting for ShipStation sign-in on the reporting laptop');
  assert.equal(gapReason(gap, [held], { pending: [{ code: 'compute_pending' }] }, { compute_pending: 'not computed yet' }), 'not computed yet');
  assert.equal(gapReason(gap, [], null, {}, { today: '2026-11-16' }), 'not computed yet', 'the week has ended and has no revision yet');
  assert.equal(gapReason({ ...gap, reason: 'before_reporting' }, [held]), null);
  const other = { weekStart: '2026-11-09', revisions: [{ status: 'blocked', hold: [{ code: 'verification_mismatch' }] }] };
  assert.equal(gapReason(gap, [other]), 'verification mismatch');
});

test('month list names why a week is missing', () => {
  const html = renderMonthList([pub, held]);
  assert.match(html, /not published: shipping costs in for 120 of 200 orders \(60%\); publishes at 95%/);
});

test('a week without a revision: not started, not finished, or (once ended) not computed yet, by the Los Angeles date', () => {
  const g = w => ({ from: w, to: w, weekStart: w, reason: 'not_published' });
  const at = today => ({ today });
  assert.equal(gapReason(g('2026-11-16'), [held], null, {}, at('2026-11-20')), 'week not finished');
  assert.equal(gapReason(g('2026-11-16'), [held], null, {}, at('2026-11-16')), 'week not finished', 'its first day');
  assert.equal(gapReason(g('2026-11-16'), [held], null, {}, at('2026-11-22')), 'week not finished', 'its last day (Sunday)');
  assert.equal(gapReason(g('2026-11-16'), [held], null, {}, at('2026-11-23')), 'not computed yet', 'ended, nothing computed');
  assert.equal(gapReason(g('2026-11-23'), [held], null, {}, at('2026-11-20')), 'week not started');
  assert.equal(gapReason(g('2026-11-30'), [held], null, {}, at('2026-11-20')), 'week not started');
  // The Worker's status for those weeks says week_open: the same words, never the raw code.
  assert.equal(gapReason(g('2026-11-16'), [held], { pending: [{ code: 'week_open' }, { code: 'shopify_export_pending' }] }, {}, at('2026-11-20')), 'week not finished');
  assert.equal(gapReason(g('2026-11-23'), [held], { pending: [{ code: 'week_open' }] }, {}, at('2026-11-20')), 'week not started');
  // A held week keeps its own reason whatever the date.
  assert.equal(gapReason(gap, [held], null, {}, at('2026-11-10')), 'shipping costs in for 120 of 200 orders (60%); publishes at 95%');
});

test('month list: the running week and later weeks are named as such', () => {
  const html = renderMonthList([pub, held], { today: '2026-11-20' });
  assert.match(html, /Nov 16–Nov 22 \(not published: week not finished\)/);
  assert.match(html, /Nov 23–Nov 29 \(not published: week not started\)/);
  assert.match(html, /Nov 30 \(not published: week not started\)/);
  assert.match(html, /Nov 1 \(not published: not computed yet\)/, 'an ended week with no revision in this list');
});
