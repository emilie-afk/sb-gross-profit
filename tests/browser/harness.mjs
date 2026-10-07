/**
 * Browser test harness: the real dashboard (static files), the real edge proxy with the site-password check and
 * reader secret, and the real Worker in-process on fixture weeks (Aug–Sep 2026) published for reading.
 * Synthetic data only. start() → { url, gateCookie, csvFile, close }.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const R = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PLAYWRIGHT = path.join(R, 'automation/shopify-export/node_modules/playwright/index.mjs');

export async function start() {
  const { dataset, freeTierRun } = await import(`${R}/worker/test/freeTierHarness.mjs`);
  const { shopifyRows } = await import(`${R}/tests/fixtures-free-tier.mjs`);
  const { toCsvText } = await import(`${R}/shared/adapters/shopifyCsv.js`);
  const { createProxy } = await import(`${R}/netlify/edge-functions/api-proxy.js`);
  const worker = (await import(`${R}/worker/src/index.js`)).default;
  const d = dataset({ n: 400, lastWeek: '2026-09-21' });
  const run = await freeTierRun(d, { verify: true });
  const env = run.env;
  env.DASHBOARD_READER_SECRET = crypto.randomBytes(30).toString('base64url');
  env.DB.db.prepare("UPDATE snapshot SET status = 'published', published_at = computed_at WHERE storage = 'chunked'").run();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbgp-browser-'));
  const days = (Date.parse(d.win.to) - Date.parse(d.win.from)) / 864e5 + 1;
  const { rows } = shopifyRows({ n: 400, from: d.win.from, days, prefix: '7' });
  const csvFile = path.join(dir, 'orders_export.csv');
  fs.writeFileSync(csvFile, toCsvText(rows, Object.keys(rows[0])));
  const DATA = path.join(dir, 'data'); fs.mkdirSync(DATA);
  for (const [k, v] of Object.entries(d.catalog.tables)) fs.writeFileSync(path.join(DATA, `${k}.json`), JSON.stringify(v));
  const SITE_PW = crypto.randomBytes(12).toString('hex');
  const proxy = createProxy({ workerOrigin: 'https://worker.test', readerSecret: env.DASHBOARD_READER_SECRET, sitePassword: SITE_PW, fetchImpl: req => worker.fetch(req, env) });
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/v1/')) {
      const body = req.method === 'GET' ? undefined : await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
      const r = await proxy(new Request(`http://localhost${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body }));
      res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); return;
    }
    if (url.pathname === '/api/mcg-extra') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
    const f = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = f.startsWith('/data/') ? path.join(DATA, f.slice(6)) : path.join(R, f);
    if (!file.startsWith(R) && !file.startsWith(DATA)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (e, buf) => { if (e) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }); res.end(buf); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, gateCookie: crypto.createHash('sha256').update(SITE_PW).digest('hex'), csvFile,
           close: () => new Promise(r => { server.close(() => r()); fs.rmSync(dir, { recursive: true, force: true }); }) };
}
