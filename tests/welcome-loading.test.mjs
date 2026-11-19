/**
 * The welcome page's <link rel="modulepreload"> list equals the page script's static import graph, so every module
 * is fetched at once (no import level waits for the one before it) and the list never drifts as files are added or
 * removed. The early-click behaviour itself is covered by tests/browser/welcome-loading.browser.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

function importGraph() {
  const start = html.indexOf('<script type="module">');
  const inline = html.slice(start, html.indexOf('</script>', start));
  const seen = new Set(), queue = [];
  const add = (spec, from) => {
    if (!spec.startsWith('.')) return;
    const p = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
    if (!seen.has(p)) { seen.add(p); queue.push(p); }
  };
  for (const m of inline.matchAll(IMPORT)) add(m[1] || m[2], '/index.html');
  while (queue.length) { const f = queue.shift(); for (const m of fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(IMPORT)) add(m[1] || m[2], f); }
  return [...seen].sort();
}

test('modulepreload lists exactly the modules the page script imports', () => {
  const preloaded = [...html.matchAll(/<link rel="modulepreload" href="\.([^"]+)">/g)].map(m => m[1]).sort();
  const graph = importGraph();
  assert.ok(graph.length > 10, 'the import graph was read');
  assert.deepEqual(preloaded, graph);
  for (const f of preloaded) assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} exists`);
});

test('welcome buttons are defined before the page script and released by it', () => {
  const stub = html.indexOf('window.__gpReady = function'), module = html.indexOf('<script type="module">');
  assert.ok(stub > 0 && stub < module, 'the early-click stub is a classic script before the page script');
  assert.ok(html.indexOf('window.__gpReady?.();') > html.lastIndexOf('window.openSaved = (mode)'), 'released after the real buttons are defined');
  for (const name of ['openSaved', 'openUpload', 'logout']) assert.ok(html.slice(0, module).includes(`window.${name} =`), `${name} defined early`);
});
