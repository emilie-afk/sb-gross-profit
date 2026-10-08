/**
 * A captured download (APS export: 300 s capture deadline) must not keep the collector process alive after the
 * step finished: after success, after a failed download and after a failed click, the process exits at once.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const child = fileURLToPath(new URL('./fixtures/run-steps-exit.mjs', import.meta.url));
function run(mode) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [child, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    const kill = setTimeout(() => p.kill(), 20000);                     // the bug kept it alive for 300 s
    p.on('exit', (code, signal) => { clearTimeout(kill); resolve({ out: out.trim(), ms: Date.now() - t0, code, signal }); });
  });
}

for (const [mode, expect] of [['ok', /^ok 8$/], ['http_500', /^failed .*report download failed \(500/], ['click_fails', /^failed element not found/]]) {
  test(`captured download (${mode}): the process exits promptly`, async () => {
    const r = await run(mode);
    assert.equal(r.signal, null, `still running after 20 s (${mode})`);
    assert.match(r.out, expect);
    assert.ok(r.ms < 10000, `exit took ${r.ms} ms`);
  });
}
