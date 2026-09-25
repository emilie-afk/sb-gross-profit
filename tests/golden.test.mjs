/**
 * Revision 8 compatibility golden (old ShipStation source contract).
 *
 * One fixed synthetic week (CSV orders only, custom ShipStation rows) goes
 * through buildSnapshot(). The sha256 of the snapshot's stable JSON is pinned
 * below. The value was computed by running this exact fixture against the
 * Revision 8 code (commit 82d9229, separate git worktree) and matches the
 * current code, so a pass means the engine is unchanged.
 *
 * History: the first pin (ad3472c2…, commit 4426f1e) included one GraphQL-shaped
 * order; the fixture was made CSV-only in C1 because there is no Shopify API path.
 *
 * If this fails, do not update the constant without an approved financial change.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { goldenHash } from './golden-fixture.mjs';

export const GOLDEN_SNAPSHOT_SHA256 = '98f6dc0cddc5e280962b9b39a36549bfee936d78b57eea59f6ad56a4a3107150';

test('Revision 8 compatibility golden hash is unchanged', () => {
  assert.equal(goldenHash(), GOLDEN_SNAPSHOT_SHA256);
});
