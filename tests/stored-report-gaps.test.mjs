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
  assert.equal(gapReason(gap, []), 'not computed yet', 'no revision yet');
  assert.equal(gapReason({ ...gap, reason: 'before_reporting' }, [held]), null);
  const other = { weekStart: '2026-11-09', revisions: [{ status: 'blocked', hold: [{ code: 'verification_mismatch' }] }] };
  assert.equal(gapReason(gap, [other]), 'verification mismatch');
});

test('month list names why a week is missing', () => {
  const html = renderMonthList([pub, held]);
  assert.match(html, /not published: shipping costs in for 120 of 200 orders \(60%\); publishes at 95%/);
});
