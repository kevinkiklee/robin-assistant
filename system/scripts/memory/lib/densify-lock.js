// densify-lock.js — orchestrator lock at <workspaceDir>/.locks/wiki-densify.lock.
// Matches the wiki-backfill convention used by memory/backfill-entity-links.js.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';

const STALE_MS = 5 * 60 * 1000;
const LOCK_NAME = 'wiki-densify.lock';

function lockPath(workspaceDir) {
  return join(workspaceDir, '.locks', LOCK_NAME);
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function readLockFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

export function sweepStaleDensifyLock(workspaceDir) {
  const path = lockPath(workspaceDir);
  if (!existsSync(path)) return false;
  const lock = readLockFile(path);
  if (!lock) {
    unlinkSync(path);
    return true;
  }
  const ageMs = Date.now() - (lock.started ?? 0);
  if (ageMs > STALE_MS || !isPidAlive(lock.pid)) {
    unlinkSync(path);
    return true;
  }
  return false;
}

export function acquireDensifyLock(workspaceDir) {
  const dir = join(workspaceDir, '.locks');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  sweepStaleDensifyLock(workspaceDir);
  const path = lockPath(workspaceDir);
  let fd;
  try {
    fd = openSync(path, 'wx');
  } catch (e) {
    if (e.code === 'EEXIST') {
      const existing = readLockFile(path);
      const holder = existing
        ? `pid=${existing.pid}, started=${new Date(existing.started).toISOString()}`
        : 'unknown';
      throw new Error(
        `densify-wiki lock held (${holder}). Retry when previous run completes, ` +
        `or run with --restart after manual cleanup.`
      );
    }
    throw e;
  }
  const meta = { pid: process.pid, started: Date.now() };
  writeFileSync(fd, JSON.stringify(meta));
  closeSync(fd);
  return { path, pid: meta.pid, started: meta.started };
}

export function releaseDensifyLock(lock) {
  if (!lock?.path || !existsSync(lock.path)) return;
  try {
    const onDisk = readLockFile(lock.path);
    if (!onDisk || onDisk.pid !== lock.pid) return;
    unlinkSync(lock.path);
  } catch {
    // best-effort
  }
}
