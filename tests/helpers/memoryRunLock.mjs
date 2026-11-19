/**
 * In-memory stand-in for the collector's OS run lock (automation/collector/src/runLock.mjs), for orchestration
 * tests: same contract (acquire → handle | null, release(handle) → boolean, only the issued handle releases),
 * no sockets, so the orchestration tests also run where the environment refuses local socket binds. The real
 * lock is covered by tests/collector-runlock.test.mjs.
 */
const held = new Set();                       // lock paths held in this process, shared by every instance
const issued = new WeakMap();

export function memoryRunLock() {
  return {
    async acquire(lockFile) {
      if (held.has(lockFile)) return null;
      held.add(lockFile);
      const handle = Object.freeze({ lockFile });
      issued.set(handle, lockFile);
      return handle;
    },
    async release(handle) {
      const lockFile = handle && typeof handle === 'object' ? issued.get(handle) : undefined;
      if (lockFile === undefined) return false;
      issued.delete(handle);
      held.delete(lockFile);
      return true;
    },
    isHeld: lockFile => held.has(lockFile),
  };
}
