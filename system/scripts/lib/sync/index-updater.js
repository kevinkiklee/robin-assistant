import { openSync, closeSync, writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync, constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { writeMemoryIndex } from '../../regenerate-memory-index.js';

function lockPath(workspaceDir) {
  return join(workspaceDir, 'user-data/state/locks/index.lock');
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function tryAcquire(path) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return false;
  }
}

function release(path) {
  try {
    unlinkSync(path);
  } catch {
    // ignore
  }
}

export async function updateIndex(workspaceDir, opts = {}) {
  const path = lockPath(workspaceDir);
  if (!tryAcquire(path)) {
    const owner = parseInt(readFileSync(path, 'utf-8').trim(), 10);
    if (Number.isFinite(owner) && pidIsAlive(owner)) {
      if (opts.skipIfLocked) return 'skipped';
      throw new Error(`INDEX lock held by live PID ${owner}`);
    }
    release(path);
    if (!tryAcquire(path)) {
      throw new Error('INDEX lock acquisition failed after stealing stale lock');
    }
  }
  try {
    writeMemoryIndex(join(workspaceDir, 'user-data/memory'));
    return 'updated';
  } finally {
    release(path);
  }
}
