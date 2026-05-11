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
  // Up to 5 iterations to absorb both empty-file races (a concurrent
  // wx-writer hasn't flushed its pid yet) and the standard
  // dead-pid-cleanup retry.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await writeFile(path, String(process.pid), { flag: 'wx' });
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Lock exists. Inspect.
      let trimmed;
      try {
        const existing = await readFile(path, 'utf8');
        trimmed = existing.trim();
      } catch {
        // Race: file vanished between EEXIST and read. Retry.
        continue;
      }
      if (trimmed === '') {
        // The wx flag does open(O_CREAT|O_EXCL) followed by write — two
        // syscalls. Another caller may have just won the exclusive open but
        // hasn't written its pid yet. Back off briefly so the next iteration
        // sees the winner's pid instead of an empty file. Do NOT unlink here:
        // unlinking would clobber the live winner.
        await new Promise((r) => setTimeout(r, 10));
        continue;
      }
      const pid = Number.parseInt(trimmed, 10);
      if (Number.isInteger(pid) && isPidAlive(pid)) {
        const err = new Error(`daemon already running (pid ${pid})`);
        err.code = 'EALREADY';
        throw err;
      }
      // Dead pid or genuinely malformed non-empty content → reclaim.
      await unlink(path).catch(() => {});
    }
  }
  const err = new Error('daemon lock acquisition failed after 5 attempts');
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
