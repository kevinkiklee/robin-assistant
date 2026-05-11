import { readFile, unlink, writeFile } from 'node:fs/promises';

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Acquire the daemon lock atomically.
 *
 * Algorithm:
 *   1. Attempt `writeFile(path, pid, { flag: 'wx' })` — exclusive create.
 *   2. On EEXIST: read existing pid; if alive, throw EALREADY.
 *   3. If existing pid is dead or unparseable, unlink and retry.
 *
 * The wx flag closes the TOCTOU window: we never read-then-write. Multiple
 * daemons racing through dead-pid cleanup converge because at most one of
 * them is alive at any moment. Bounded loop guards against pathological
 * thrashing.
 */
export async function acquireDaemonLock(path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(path, String(process.pid), { flag: 'wx' });
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Lock exists. Inspect.
      let pid = NaN;
      try {
        const existing = await readFile(path, 'utf8');
        pid = Number.parseInt(existing.trim(), 10);
      } catch {
        // Race: file vanished between EEXIST and read. Retry.
        continue;
      }
      if (Number.isInteger(pid) && isPidAlive(pid)) {
        const err = new Error(`daemon already running (pid ${pid})`);
        err.code = 'EALREADY';
        throw err;
      }
      // Dead or malformed. Unlink and retry.
      await unlink(path).catch(() => {});
    }
  }
  const err = new Error('daemon lock acquisition failed after 3 attempts');
  err.code = 'EALREADY';
  throw err;
}

export async function releaseDaemonLock(path) {
  try {
    await unlink(path);
  } catch {
    /* idempotent */
  }
}
