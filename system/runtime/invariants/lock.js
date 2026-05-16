// Per-invariant repair lock with heartbeat refresh.
//
// Lock file: <invariantsLocks>/<name>.lock
// Contents: { pid, started_at, heartbeat_at }
// Stale: heartbeat_at older than STALE_AFTER_MS is reclaimed with a warning.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const STALE_AFTER_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 10_000;

export function lockPath(dir, name) {
  return join(dir, `${name}.lock`);
}

function readLock(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeLock(path, payload) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload), { mode: 0o644 });
  renameSync(tmp, path);
}

export function isLockStale(payload, now = Date.now()) {
  if (!payload || typeof payload.heartbeat_at !== 'number') return true;
  return now - payload.heartbeat_at > STALE_AFTER_MS;
}

/**
 * Acquire the repair lock for one invariant. Returns null if held by a live owner,
 * or a release fn + refresh fn pair on success.
 */
export function acquire(dir, name, { now = () => Date.now(), pid = process.pid } = {}) {
  mkdirSync(dir, { recursive: true });
  const path = lockPath(dir, name);
  const existing = readLock(path);
  const ts = now();
  if (existing && !isLockStale(existing, ts)) {
    return null;
  }
  const payload = { pid, started_at: ts, heartbeat_at: ts };
  writeLock(path, payload);
  let released = false;
  const refresh = () => {
    if (released) return;
    const cur = readLock(path);
    if (!cur || cur.pid !== pid) return; // someone else stole it
    writeLock(path, { ...cur, heartbeat_at: now() });
  };
  const release = () => {
    if (released) return;
    released = true;
    try {
      const cur = readLock(path);
      if (cur && cur.pid === pid) unlinkSync(path);
    } catch {
      // best-effort
    }
  };
  return { release, refresh };
}

/**
 * Wrap an async repair function so the lock heartbeats while it runs.
 * Caps repair at the given timeout (default 30s).
 */
export async function withLock(
  dir,
  name,
  fn,
  { timeoutMs = 30_000, intervalMs = HEARTBEAT_INTERVAL_MS } = {},
) {
  const handle = acquire(dir, name);
  if (!handle) {
    return { acquired: false };
  }
  const beat = setInterval(handle.refresh, intervalMs);
  beat.unref?.();
  const timer = new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error(`repair_timeout:${name}`)), timeoutMs);
    t.unref?.();
  });
  try {
    const result = await Promise.race([fn(), timer]);
    return { acquired: true, result };
  } finally {
    clearInterval(beat);
    handle.release();
  }
}
