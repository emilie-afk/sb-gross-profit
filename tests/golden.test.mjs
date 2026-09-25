/**
 * Financial-engine golden hash.
 *
 * One fixed synthetic week (CSV orders, GraphQL orders, custom ShipStation rows)
 * goes through buildSnapshot(). The sha256 of the snapshot's stable JSON is
 * pinned below. It was computed on the Revision 8 branch (22f9ecc) before any
 * automation-P1 change, so a pass here means P1 left the engine untouched.
 *
 * If this fails, do not update the constant without an approved financial change.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { goldenHash } from './golden-fixture.mjs';

export const GOLDEN_SNAPSHOT_SHA256 = 'ad3472c27e9a547f086f31a1f244dfe77413795dc05d1ab8d254663a8faad24c';

test('financial-engine golden hash is unchanged', () => {
  assert.equal(goldenHash(), GOLDEN_SNAPSHOT_SHA256);
});
