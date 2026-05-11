import { readFile, unlink, writeFile } from 'node:fs/promises';

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export async function acquireDaemonLock(path) {
  try {
    const existing = await readFile(path, 'utf8');
    const pid = Number.parseInt(existing.trim(), 10);
    if (Number.isInteger(pid) && isPidAlive(pid)) {
      const err = new Error(`daemon already running (pid ${pid})`);
      err.code = 'EALREADY';
      throw err;
    }
    await unlink(path).catch(() => {});
  } catch (e) {
    if (e.code === 'EALREADY') throw e;
    if (e.code !== 'ENOENT') {
      // fall through; we'll attempt to write
    }
  }
  await writeFile(path, String(process.pid), { flag: 'w' });
}

export async function releaseDaemonLock(path) {
  try {
    await unlink(path);
  } catch {
    /* idempotent */
  }
}
