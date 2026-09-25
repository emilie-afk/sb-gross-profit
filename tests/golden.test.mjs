/**
 * Financial-engine goldens.
 *
 * 1. Revision 8 compatibility (old ShipStation source contract). One fixed
 *    synthetic week (CSV orders only, custom ShipStation rows) goes through
 *    buildSnapshot() on the mapping-export source with the legacy rules. The
 *    sha256 of the snapshot's stable JSON is pinned below. It was computed by
 *    running this exact fixture against the Revision 8 code (commit 82d9229,
 *    separate git worktree). C3 renamed the engine-version label only, so the
 *    label is normalized to the Revision 8 value before hashing; any other
 *    difference fails.
 *    History: the first pin (ad3472c2…, commit 4426f1e) included one
 *    GraphQL-shaped order; the fixture was made CSV-only in C1.
 *
 * 2. C3 (Revision 9): the same week on the Shipping Cost Report source with the
 *    C3 rules. Pinned when C3 was introduced (approved C3 scope, 2026-09-25).
 *    C4a changed only the engine-version label for this fixture (it has no
 *    refunded order with a Route line), so the label is normalized to the C3
 *    value before hashing.
 *
 * If either fails, do not update the constant without an approved financial change.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { goldenHash, goldenHashC3, goldenSnapshot, goldenSnapshotC3 } from './golden-fixture.mjs';

export const GOLDEN_SNAPSHOT_SHA256 = '98f6dc0cddc5e280962b9b39a36549bfee936d78b57eea59f6ad56a4a3107150';
export const GOLDEN_C3_SNAPSHOT_SHA256 = '3a60c4539ac436b24f759e790b869394bdd87d5cb48be125f4a8ec84e9d9aa4e';

test('Revision 8 compatibility golden hash is unchanged', () => {
  assert.equal(goldenHash(), GOLDEN_SNAPSHOT_SHA256);
});

test('C3 golden hash is unchanged', () => {
  assert.equal(goldenHashC3(), GOLDEN_C3_SNAPSHOT_SHA256);
});

test('old and new golden outputs: only shipping moves, and exactly by the report difference', () => {
  const o = goldenSnapshot().totals, n = goldenSnapshotC3().totals;
  assert.deepEqual([o.operatingRevenue, o.knownProductCogs], [n.operatingRevenue, n.knownProductCogs], 'revenue and COGS unchanged');
  // Old: 900101 Carrier Fee 6.25, 900102 Rate 4.10, 900104 zero (missing), 900105 5.40, HPD pass-through 9.50.
  assert.equal(o.shippingExpense, 25.25);
  // New: report 6.12 + 8.70 (two rows) + 5.40, HPD pass-through 9.50; 900104 has no row.
  assert.equal(n.shippingExpense, 29.72);
  assert.equal(Math.round((o.operatingGpAfterShipping - n.operatingGpAfterShipping) * 100) / 100, 4.47);
  assert.equal(n.labels.c3.lifecycle.status, 'shipping_order_coverage_open');
  assert.deepEqual([n.labels.c3.coverage.numerator, n.labels.c3.coverage.denominator], [3, 4]);
  assert.equal(n.labels.c3.publicationShippingStatus, null, 'not publishable: source unverified, provisional publication off');
});
