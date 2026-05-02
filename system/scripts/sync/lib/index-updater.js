import { openSync, closeSync, writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync, constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { writeMemoryIndex } from '../../memory/regenerate-index.js';

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

function readOwnerPid(path) {
  try {
    const raw = readFileSync(path, 'utf-8').trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export async function updateIndex(workspaceDir, opts = {}) {
  const path = lockPath(workspaceDir);
  if (!tryAcquire(path)) {
    const owner = readOwnerPid(path);
    if (owner != null && pidIsAlive(owner)) {
      if (opts.skipIfLocked) return 'skipped';
      throw new Error(`INDEX lock held by live PID ${owner}`);
    }
    // Lock looks stale (PID dead, missing, or unparseable). Steal it.
    release(path);
    if (!tryAcquire(path)) {
      // Lost the race — another process acquired between our release and
      // re-acquire. Report whoever holds it now (not "stale-lock" — that
      // misleads operators).
      const newOwner = readOwnerPid(path);
      if (newOwner != null && pidIsAlive(newOwner)) {
        if (opts.skipIfLocked) return 'skipped';
        throw new Error(`INDEX lock newly acquired by PID ${newOwner} after stale-lock reclaim`);
      }
      throw new Error('INDEX lock acquisition failed after stale-lock reclaim');
    }
  }
  try {
    writeMemoryIndex(join(workspaceDir, 'user-data/memory'));
    return 'updated';
  } finally {
    release(path);
  }
}
