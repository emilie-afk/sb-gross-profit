/**
 * Collector entry points end by setting process.exitCode, never by calling process.exit(): on the Windows laptop
 * (Node 24) an exit while fetch's sockets were closing aborted with a libuv assertion (0xC0000409) right after a
 * successful recovery check (Oct 8), so the task reported a crash instead of exit 0 / 40 / 42.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('the weekly collector entry point never calls process.exit()', () => {
  const src = fs.readFileSync(new URL('../automation/collector/src/run.mjs', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.equal((src.match(/process\.exit\(/g) || []).length, 0);
  for (const code of [0, 40, 42]) assert.match(src, new RegExp(`recoveryExit = (?:[^;]*\\b${code}\\b)`), `recovery exit ${code} is set as a code`);
  assert.match(src, /if \(recoveryExit !== null\) process\.exitCode = recoveryExit;/);
});
