/**
 * Local dry run of tools/proxy-smoke.mjs (the script run against a deployed site): the three edge functions and the
 * Worker in-process behind a plain HTTP server on 127.0.0.1 that passes raw paths through, as Netlify's edge does.
 * Synthetic password and keys only. Every smoke check must pass.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { spawn } from 'node:child_process';
const R = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const worker = (await import(`${R}/worker/src/index.js`)).default;
const { makeEnv, rnd } = await import(`${R}/worker/test/helpers.mjs`);
const { createLogin } = await import(`${R}/netlify/edge-functions/auth-login.js`);
const { createGate } = await import(`${R}/netlify/edge-functions/auth.js`);
const { createProxy } = await import(`${R}/netlify/edge-functions/api-proxy.js`);
const { gateConfig } = await import(`${R}/tests/gate-fixture.mjs`);
test('tools/proxy-smoke.mjs passes every check against the gate, proxy and Worker run locally', { timeout: 120_000 }, async () => {
  const g = gateConfig();
  const wenv = await makeEnv({ GATE_SECRET: g.gateSecret, DASHBOARD_READER_SECRET: rnd() });
  const W = 'https://worker.invalid';
  const vars = { SITE_PASSWORD: g.sitePassword, GATE_SIGNING_KEY: g.signingKey, GATE_SESSION_EPOCH: '1', SB_WORKER_ORIGIN: W, SB_WORKER_GATE_SECRET: g.gateSecret, SB_WORKER_READER_SECRET: wenv.DASHBOARD_READER_SECRET };
  const env = k => vars[k];
  const fetchImpl = async (i, init) => worker.fetch(i instanceof Request ? i : new Request(i, init), wenv);
  const login = createLogin({ env, fetchImpl }), gate = createGate({ env, fetchImpl });
  const proxy = createProxy({ workerOrigin: W, readerSecret: vars.SB_WORKER_READER_SECRET, sitePassword: g.sitePassword, signingKey: g.signingKey, epoch: '1', fetchImpl });
  const STATIC = async () => new Response(JSON.stringify({ generatedAt: 'x' }), { headers: { 'content-type': 'application/json' } });
  const server = http.createServer(async (req, res) => {
    const body = req.method === 'GET' ? undefined : await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
    const raw = req.url;   // raw path, as Netlify's edge would receive it
    const request = new Request(`http://127.0.0.1${raw}`, { method: req.method, headers: req.headers, body });
    const path = new URL(request.url).pathname;
    const r = path === '/__auth' ? await login(request, { ip: '127.0.0.1' }) : path.startsWith('/api/v1/') ? await proxy(request) : await gate(request, { ip: '127.0.0.1', next: STATIC });
    const h = {}; r.headers.forEach((v, k) => { if (k !== 'set-cookie') h[k] = v; });
    const sc = r.headers.getSetCookie(); if (sc.length) h['set-cookie'] = sc;
    res.writeHead(r.status, h); res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const site = `http://127.0.0.1:${server.address().port}`;
  let out = '';
  const code = await new Promise(resolve => {
    const child = spawn(process.execPath, [`${R}/tools/proxy-smoke.mjs`, site], { env: { ...process.env, SITE_PASSWORD: g.sitePassword }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
    child.on('exit', resolve);
  });
  server.close();
  assert.equal(code, 0, out.split('\n').filter(l => l.startsWith('FAIL')).join('\n'));
  assert.ok(!out.includes(g.sitePassword), 'the smoke script never prints the password');
  assert.ok((out.match(/^PASS/gm) || []).length >= 27);
});
