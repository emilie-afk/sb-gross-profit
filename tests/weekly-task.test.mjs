/**
 * The Windows task wrapper (automation/collector/windows/weekly-task.ps1), run by PowerShell with a fake
 * collector that exits with scripted codes. Skipped when no `pwsh` is available (set PWSH to its path).
 * Checks: only exit 0 writes the done marker; 42 (quota deferral) stops at once; 41 (Shopify sign-in)
 * retries without using up the partial retries; an attempt that overruns is stopped with its process
 * and its collector lock released; a start never runs past its own deadline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PWSH = process.env.PWSH || ['pwsh', '/usr/bin/pwsh', '/usr/local/bin/pwsh'].find(p => spawnSync(p, ['-NoProfile', '-c', '1'], { stdio: 'ignore' }).status === 0);
const SKIP = !PWSH || process.platform === 'win32';

function rig(codes, { sleepFirst = 0, done = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtask-'));
  const base = path.join(dir, 'base'), repo = path.join(dir, 'repo');
  if (done) { fs.mkdirSync(base, { recursive: true }); fs.writeFileSync(path.join(base, 'done-2026-10-05.txt'), 'x'); }
  fs.mkdirSync(path.join(repo, 'automation', 'collector'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'codes'), codes.join('\n') + '\n');
  // The fake collector: takes the next code; the first attempt can hold the lock and hang.
  const fake = path.join(dir, 'fake-node');
  fs.writeFileSync(fake, `#!/bin/bash
n=$(cat "${dir}/count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${dir}/count"; echo "$*" >> "${dir}/args"
code=$(sed -n "\${n}p" "${dir}/codes"); [ -z "$code" ] && code=40
mkdir -p "${base}"
if [ "$n" = "1" ] && [ "${sleepFirst}" != "0" ]; then echo "{\\"pid\\":$$}" > "${base}/collector.lock"; sleep ${sleepFirst}; fi
exit $code
`);
  fs.chmodSync(fake, 0o755);
  const run = extra => {
    const t0 = Date.now();
    const r = spawnSync(PWSH, ['-NoProfile', '-File', path.join(REPO, 'automation/collector/windows/weekly-task.ps1'), '-RepoDir', repo, '-BaseDir', base, '-NodePath', fake,
      '-Week', '2026-10-05', '-RetryMinutes', '0.01', '-SignInRetryMinutes', '0.01', '-MinAttemptMinutes', '0.01', ...extra], { encoding: 'utf8', timeout: 120_000 });
    return { code: r.status, seconds: (Date.now() - t0) / 1000, attempts: Number(fs.readFileSync(path.join(dir, 'count'), 'utf8')),
             done: fs.existsSync(path.join(base, 'done-2026-10-05.txt')), lock: fs.existsSync(path.join(base, 'collector.lock')),
             args: fs.existsSync(path.join(dir, 'args')) ? fs.readFileSync(path.join(dir, 'args'), 'utf8').trim().split('\n') : [],
             log: fs.existsSync(path.join(base, 'logs', 'task-2026-10-05.log')) ? fs.readFileSync(path.join(base, 'logs', 'task-2026-10-05.log'), 'utf8') : '' };
  };
  return { run };
}

test('task wrapper: partial runs retry; only exit 0 writes the done marker', { skip: SKIP }, () => {
  const r = rig([40, 40, 0]).run([]);
  assert.deepEqual([r.code, r.attempts, r.done], [0, 3, true]);
  const again = rig([40, 40, 40, 40]).run(['-Retries', '2']);
  assert.deepEqual([again.code, again.attempts, again.done], [40, 3, false]);
});

test('task wrapper: a quota deferral (42) stops at once without a done marker', { skip: SKIP }, () => {
  const r = rig([42, 0]).run([]);
  assert.deepEqual([r.code, r.attempts, r.done], [42, 1, false]);
  assert.match(r.log, /deferred/);
});

test('task wrapper: Shopify sign-in attempts (41) repeat without using up the partial retries', { skip: SKIP }, () => {
  const r = rig([41, 41, 41, 41, 0]).run(['-Retries', '1']);
  assert.deepEqual([r.code, r.attempts, r.done], [0, 5, true]);
});

test('task wrapper: an attempt that overruns is stopped, its lock released, and retried', { skip: SKIP }, () => {
  const r = rig([0, 0], { sleepFirst: 60 }).run(['-AttemptMinutes', '0.05']);
  assert.deepEqual([r.code, r.attempts, r.done, r.lock], [0, 2, true, false]);
  assert.match(r.log, /overran/);
  assert.match(r.log, /released the lock/);
  assert.ok(r.seconds < 30, `stopped after ~3 s, not 60 (${r.seconds} s)`);
});

test('task wrapper: a start ends before its own deadline (the task limit minus the safety margin)', { skip: SKIP }, () => {
  const r = rig([41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41, 41], { sleepFirst: 0 })
    .run(['-TaskLimitMinutes', '0.15', '-SafetyMinutes', '0.05']);
  assert.equal(r.code, 41);
  assert.ok(r.seconds < 10, `ended within its 6 s window (${r.seconds} s)`);
  assert.equal(r.done, false);
});

test('task wrapper: a week already done makes a recovery start: one cheap --recovery attempt, never a loop or a full collection', { skip: SKIP }, () => {
  const nothing = rig([0], { done: true }).run([]);
  assert.deepEqual([nothing.code, nothing.attempts, nothing.done], [0, 1, true]);
  assert.match(nothing.args[0], /--recovery/);
  const work = rig([40, 0], { done: true }).run([]);
  assert.deepEqual([work.code, work.attempts, work.done], [40, 1, true], 'one attempt; the next trigger checks again');
  const first = rig([0]).run([]);
  assert.ok(!first.args[0].includes('--recovery'), 'a week not yet done is a normal start');
});
