/**
 * runLock.mjs — one collector run at a time, held by the operating system
 * =======================================================================
 * The lock is a listening local endpoint whose name is derived from the lock file's path: a named pipe on
 * Windows (\\.\pipe\sb-collector-<id>), an abstract Unix socket on Linux, a 127.0.0.1 port elsewhere. Only one
 * process can listen on it; a second start gets EADDRINUSE. The OS closes it when the owning process exits
 * for any reason (crash, kill, the Windows session ending), so there is no stale lock to detect, no timeout,
 * and nothing to delete: a paused but living owner keeps it, and after a crash exactly one of the starts that
 * race to recover can bind it.
 *
 * The lock file itself (collector.lock) is only information for other tools (pid, start time, token). It never
 * decides who holds the lock. acquireRunLock returns an opaque, frozen handle; the endpoint and token live in a
 * module-private WeakMap keyed by that exact object, so releaseRunLock acts only for a handle this module issued
 * and has not released yet. Any other object (fabricated, copied, or already released) is refused.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/** The OS endpoint for a lock file path (stable across runs and processes on this PC). */
export function runLockAddress(lockFile, platform = process.platform) {
  const id = crypto.createHash('sha256').update(path.resolve(lockFile).toLowerCase()).digest('hex').slice(0, 24);
  if (platform === 'win32') return { path: `\\\\.\\pipe\\sb-collector-${id}` };
  if (platform === 'linux') return { path: `\0sb-collector-${id}` };
  return { host: '127.0.0.1', port: 20000 + (parseInt(id.slice(0, 8), 16) % 30000) };
}

/** Issued handles → { server, lockFile, token }. Private to this module; entries are removed on release. */
const ISSUED = new WeakMap();

/**
 * @returns {Promise<Readonly<{ lockFile: string }> | null>} an opaque handle, or null when another process holds the lock
 */
export async function acquireRunLock(lockFile, { netImpl = net, platform = process.platform, fsImpl = fs, now = Date.now() } = {}) {
  const addr = runLockAddress(lockFile, platform);
  const server = netImpl.createServer(socket => socket.destroy());
  const bound = await new Promise((resolve, reject) => {
    server.once('error', e => (e.code === 'EADDRINUSE' ? resolve(false) : reject(e)));
    server.listen(addr.path !== undefined ? { path: addr.path, exclusive: true } : { host: addr.host, port: addr.port, exclusive: true }, () => resolve(true));
  });
  if (!bound) return null;
  server.unref();                                                       // never keeps the process alive by itself
  const token = crypto.randomUUID();
  try {
    fsImpl.mkdirSync(path.dirname(lockFile), { recursive: true });
    fsImpl.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: new Date(now).toISOString(), token, lock: 'os' }));
  } catch { /* information only */ }
  const handle = Object.freeze({ lockFile });
  ISSUED.set(handle, { server, lockFile, token });
  return handle;
}

/**
 * Releases a lock this process holds. Only the exact handle returned by acquireRunLock, once, is accepted: any
 * other value (fabricated or copied objects, a handle already released) returns false and changes nothing —
 * neither the endpoint nor the information file.
 */
export async function releaseRunLock(handle, { fsImpl = fs } = {}) {
  const held = (handle !== null && typeof handle === 'object') ? ISSUED.get(handle) : undefined;
  if (!held) return false;
  ISSUED.delete(handle);
  try { if (JSON.parse(fsImpl.readFileSync(held.lockFile, 'utf8')).token === held.token) fsImpl.rmSync(held.lockFile, { force: true }); }
  catch { /* gone or unreadable: leave it */ }
  await new Promise(resolve => held.server.close(() => resolve()));
  return true;
}
