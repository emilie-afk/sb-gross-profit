/**
 * C8: the collectors' manifest summary prints allowlisted aggregates only.
 * Synthetic manifests; every forbidden value is planted and must not appear.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeManifest } from '../automation/collector/src/summary.mjs';

const H = 'a'.repeat(64);
test('C8 summary: Shopify and ShipStation manifests reduce to codes, counts, hashes and host names', () => {
  const shopify = { runId: 'shx_1', kind: 'shopify_orders_export', weekStart: '2026-09-14', weekEnd: '2026-09-20', windowFrom: '2026-07-27', windowTo: '2026-09-20',
    startedAt: '2026-09-21T08:05:00.000Z', finishedAt: '2026-09-21T08:20:00.000Z', status: 'ok', exitCode: 0, mailboxVerified: true, authStateAtStart: 'authenticated',
    email: { messageIdSha256: 'b'.repeat(16), receivedAt: '2026-09-21T08:12:00.000Z', polls: 7, subject: 'Your export is ready', from: 'person@example.com' },
    downloadHost: 'storage.shopifycloud.com', download: { via: 'email_link', bytes: 1234567, format: 'shopify_orders_csv', link: 'https://x.shopifycloud.com/secret-token' },
    facts: { rawSha256: H, sanitizedSha256: H, rowCount: 5810, orderCount: 3137, columns: ['Name', 'Email'] },
    ingest: { ok: true, httpStatus: 200, attempts: 1, sourceStatus: 'source_received', sourceHash: H, json: { note: 'C:\\Users\\someone' } },
    error: 'failed for person@example.com at C:\\Users\\x', evidence: { url: 'https://admin.shopify.com/store/secret' } };
  const ss = { kind: 'shipstation_shipping_cost_report', weekStart: '2026-09-14', status: 'ok', exitCode: 0, startedAt: '2026-09-21T08:05:00.000Z',
    rawSha256: H, sanitizedSha256: H, rowCount: 2377, shippingCostTotal: 13546.75, requestedFrom: '2026-07-27', requestedTo: '2026-09-20',
    dropped: { Recipient: 1, 'Shipping Paid': 1, '+/-': 1 }, reviewFlags: { insurance_nonzero: 3 }, file: 'C:\\Users\\x\\report.csv',
    ingest: { httpStatus: 200, attempts: 2, sourceStatus: 'source_no_change', sourceHash: H } };
  const a = summarizeManifest(shopify), b = summarizeManifest(ss);
  assert.deepEqual([a.status, a.orders, a.rows, a.downloadHost, a.downloadVia, a.emailPolls, a.sourceStatus, a.mailboxVerified], ['ok', 3137, 5810, 'storage.shopifycloud.com', 'email_link', 7, 'source_received', true]);
  assert.deepEqual([b.rows, b.shippingCostTotal, b.droppedColumns, b.reviewFlags, b.sourceStatus, b.uploadAttempts], [2377, 13546.75, 3, ['insurance_nonzero'], 'source_no_change', 2]);
  const text = JSON.stringify([a, b]);
  for (const bad of ['@', 'example.com', 'secret', 'C:\\', 'Users', 'Your export', 'https://', 'Email', 'Recipient']) assert.ok(!text.includes(bad), bad);
});
