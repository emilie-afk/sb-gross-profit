/**
 * The collector's run lock is held by the operating system (runLock.mjs): exactly one process can hold it,
 * a paused owner keeps it, it is freed when its owner exits (even by a crash), and only its owner can release it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { acquireRunLock, releaseRunLock, runLockAddress } from '../automation/collector/src/runLock.mjs';
import { runWeeklyCollection } from '../automation/collector/src/orchestrate.mjs';

const MODULE = new URL('../automation/collector/src/runLock.mjs', import.meta.url).href;   // a file URL: Windows paths are not import specifiers
const tmpLock = name => path.join(fs.mkdtempSync(path.join(os.tmpdir(), `sb-runlock-${name}-`)), 'collector.lock');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Some sandboxes refuse local socket binds (EPERM/EACCES): the lock cannot work there, so those tests are skipped. */
const BIND = await (async () => {
  try { const h = await acquireRunLock(tmpLock('probe')); await releaseRunLock(h); return false; }
  catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) return `this environment refuses local socket binds (${e.code})`; throw e; }
})();

/** A separate collector start: tries the lock, prints "acquired" or "busy", holds it for holdMs, then exits. */
function start(lockFile, { holdMs = 0, hang = false } = {}) {
  const code = `import { acquireRunLock } from ${JSON.stringify(MODULE)};
    const h = await acquireRunLock(${JSON.stringify(lockFile)});
    console.log(h ? 'acquired' : 'busy');
    if (h && ${hang}) setInterval(() => {}, 1000);
    else if (h) setTimeout(() => process.exit(0), ${holdMs});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  child.exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  // Never hangs: a child that dies before answering resolves as "exited (<code>)".
  child.result = new Promise(resolve => { let out = ''; child.stdout.on('data', d => { out += d; if (/acquired|busy/.test(out)) resolve(out.trim()); }); child.exited.then(c => resolve(`exited (${c})`)); });
  return child;
}

test('run lock: one holder in a process; released by its owner only', { skip: BIND }, async () => {
  const lockFile = tmpLock('one');
  const a = await acquireRunLock(lockFile);
  assert.ok(a);
  assert.equal(await acquireRunLock(lockFile), null, 'second start refused');
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid, process.pid, 'information file written');
  assert.equal(await releaseRunLock(a), true);
  assert.equal(fs.existsSync(lockFile), false);
  const b = await acquireRunLock(lockFile);
  assert.ok(b, 'free again after release');
  await releaseRunLock(b);
});

test('run lock: a caller with no ownership cannot release it or delete the lock file', { skip: BIND }, async () => {
  const lockFile = tmpLock('noowner');
  const a = await acquireRunLock(lockFile);
  const info = fs.readFileSync(lockFile, 'utf8');
  const closes = [];
  const fabricated = { server: { close: cb => { closes.push('fabricated'); cb(); } }, lockFile, token: JSON.parse(info).token };
  for (const nobody of [undefined, null, 'collector.lock', {}, { lockFile }, { ...a }, Object.freeze({ lockFile }), fabricated]) {
    assert.equal(await releaseRunLock(nobody), false, `refused: ${JSON.stringify(nobody)}`);
  }
  assert.deepEqual(closes, [], "a fabricated handle's close is never called");
  assert.equal(fs.readFileSync(lockFile, 'utf8'), info, 'lock file untouched');
  assert.equal(await acquireRunLock(lockFile), null, 'still held by its owner');
  assert.equal(await releaseRunLock(a), true);
  assert.equal(await releaseRunLock(a), false, 'releasing twice does nothing');
});

test('run lock: a paused, living owner keeps the lock however long it is paused', { skip: BIND || (process.platform === 'win32' && 'needs SIGSTOP') }, async () => {
  const lockFile = tmpLock('paused');
  const owner = start(lockFile, { hang: true });
  assert.equal(await owner.result, 'acquired');
  process.kill(owner.pid, 'SIGSTOP');                                  // paused: alive but doing nothing
  try {
    await sleep(300);
    assert.equal(await acquireRunLock(lockFile, { now: Date.now() + 24 * 3600_000 }), null, 'no timeout hands it over');
    const other = start(lockFile);
    assert.equal(await other.result, 'busy', 'another process is refused too');
    await other.exited;
  } finally {
    process.kill(owner.pid, 'SIGCONT');
    process.kill(owner.pid, 'SIGTERM');
    await owner.exited;
  }
  const after = await acquireRunLock(lockFile);
  assert.ok(after, 'free once the owner has exited');
  await releaseRunLock(after);
});

test('run lock: after a crash, starts racing to recover — exactly one gets the lock', { skip: BIND }, async () => {
  const lockFile = tmpLock('crash');
  const owner = start(lockFile, { hang: true });
  assert.equal(await owner.result, 'acquired');
  owner.kill('SIGKILL');                                                // crash: no cleanup runs
  await owner.exited;
  assert.ok(fs.existsSync(lockFile), 'the crashed run left its information file');
  const racers = Array.from({ length: 5 }, () => start(lockFile, { holdMs: 1500 }));
  const local = await Promise.all(Array.from({ length: 5 }, () => acquireRunLock(lockFile)));
  const results = [...await Promise.all(racers.map(c => c.result)), ...local.map(h => (h ? 'acquired' : 'busy'))];
  assert.equal(results.filter(r => r === 'acquired').length, 1, `exactly one holder: ${results.join(',')}`);
  for (const h of local) if (h) await releaseRunLock(h);
  await Promise.all(racers.map(c => c.exited));
  const after = await acquireRunLock(lockFile);
  assert.ok(after);
  await releaseRunLock(after);
});

test('run lock: different lock files are different locks; the endpoint name is stable', () => {
  assert.notDeepEqual(runLockAddress('/a/collector.lock', 'linux'), runLockAddress('/b/collector.lock', 'linux'));
  assert.deepEqual(runLockAddress('/a/collector.lock', 'linux'), runLockAddress('/a/collector.lock', 'linux'));
  assert.match(runLockAddress('C:\\x\\collector.lock', 'win32').path, /^\\\\\.\\pipe\\sb-collector-[0-9a-f]{24}$/);
});

test('run lock: a fabricated handle (server.close + the real token) is refused and deletes nothing', { skip: BIND }, async () => {
  const lockFile = tmpLock('fabricated');
  const real = await acquireRunLock(lockFile);
  const token = JSON.parse(fs.readFileSync(lockFile, 'utf8')).token;
  let closed = false;
  const fake = { server: { close: cb => { closed = true; cb?.(); } }, lockFile, token };
  assert.equal(await releaseRunLock(fake), false);
  assert.equal(closed, false);
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).token, token, 'diagnostic file kept');
  assert.equal(await acquireRunLock(lockFile), null, 'lock still held by the real owner');
  assert.ok(Object.isFrozen(real) && !('server' in real) && !('token' in real), 'the issued handle exposes nothing to copy');
  assert.equal(await releaseRunLock(real), true);
  assert.equal(await releaseRunLock(real), false, 'a released handle is refused');
  assert.equal(fs.existsSync(lockFile), false);
});

test('run lock: without a lock, a fabricated handle still cannot delete a diagnostic file', async () => {
  const lockFile = tmpLock('nofake');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 1, at: '2026-11-17T00:00:00.000Z', token: 't' }));
  const fake = { server: { close: cb => cb?.() }, lockFile, token: 't' };
  assert.equal(await releaseRunLock(fake), false);
  assert.ok(fs.existsSync(lockFile));
});

test('run lock: a collector.lock left by a crashed run (dead pid, any age) never blocks; the orchestrator uses the real lock by default', { skip: BIND }, async () => {
  const lockFile = tmpLock('leftover');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, at: '2026-01-01T00:00:00.000Z', token: 'old' }));
  const past = new Date('2026-01-01T00:00:00Z'); fs.utimesSync(lockFile, past, past);
  const d = {
    week: { weekStart: '2026-09-14', weekEnd: '2026-09-20', closed: true }, lockFile, stateFile: path.join(path.dirname(lockFile), 'state.json'),
    weekPlan: async () => ({ weekStart: '2026-09-14', collected: { shopify: 'ok', shopify_updates: 'ok', shipping_cost_report: 'ok' } }),
    shipstation: { collect: async () => assert.fail('not needed'), upload: async () => assert.fail('not needed') },
    shopify: { run: async () => assert.fail('not needed') },
  };
  const held = await acquireRunLock(lockFile);                           // the default (OS) lock is the one the run uses
  assert.ok(held, 'the leftover file did not block');
  assert.equal((await runWeeklyCollection(d)).status, 'already_running');
  await releaseRunLock(held);
  assert.notEqual((await runWeeklyCollection(d)).status, 'already_running');
  assert.ok(await acquireRunLock(lockFile), 'the run released the OS lock');
});

