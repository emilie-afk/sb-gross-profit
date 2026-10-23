/**
 * Dashboard side of the Free-tier path: the week status is reachable through the
 * same-origin proxy (gate session only; never the collector or verifier routes), and the
 * Reports screen renders the verified-draft target and the exact pending status, escaped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/src/index.js';
import { gateConfig, gateCookieHeader } from './gate-fixture.mjs';
import { createProxy } from '../netlify/edge-functions/api-proxy.js';
import { renderAutomationStatus } from '../js/automationStatus.js';
import { freeTierEnv } from '../worker/test/freeTierHarness.mjs';

const SITE = 'https://sb-profit.netlify.app', WORKER = 'https://sb-gp-worker.example.workers.dev';

test('the proxy forwards the week status to a signed-in session and nothing on /v1/collect or /v1/verify', async () => {
  const env = await freeTierEnv();
  env.DASHBOARD_READER_SECRET = 'r'.repeat(40);
  const g = gateConfig();
  const proxy = createProxy({ workerOrigin: WORKER, readerSecret: env.DASHBOARD_READER_SECRET, ...g, fetchImpl: req => worker.fetch(req, env) });
  const cookie = await gateCookieHeader(g);
  const r = await proxy(new Request(`${SITE}/api/v1/weeks/2026-09-14/status`, { headers: { cookie } }));
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.ok(s.pending.some(p => p.code === 'shopify_export_pending'));
  for (const p of ['/api/v1/collect/weeks/2026-09-14/manifest', '/api/v1/verify/pending', '/api/v1/collect/weeks/2026-09-14/status']) {
    assert.equal((await proxy(new Request(`${SITE}${p}`, { headers: { cookie } }))).status, 404, p);
  }
});

test('the Reports screen shows the target, what is pending and the verification, and escapes every value', () => {
  const html = renderAutomationStatus({ weekStart: '2026-09-14', freeTier: {
    dueAt: '2026-09-21T08:30:00.000Z', target: 'pending', label: 'Draft computed; independent verification not finished',
    pending: [{ code: 'verification_pending', label: '<b>Draft computed</b>' }],
    draft: { revision: 2, computedAt: '2026-09-21T08:20:00.000Z', status: 'blocked' },
    verification: { status: 'verified', at: '2026-09-21T08:25:00.000Z', counts: { ordersChecked: 380, orderMismatches: 0 } } } });
  assert.match(html, /Verified-draft target/);
  assert.match(html, /21 Sept?,? 15:30 ICT/);
  assert.match(html, /&lt;b&gt;Draft computed&lt;\/b&gt;/);
  assert.match(html, /380 orders checked, 0 differing/);
  assert.ok(!html.includes('<b>Draft'));
});
