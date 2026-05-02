// Atomic file primitives: content-addressed write, atomic rename, atomic O_EXCL lock.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

// Write a file content-addressed: skip the write entirely if the on-disk
// content already equals `content`. Returns true if a write happened.
export function writeIfChanged(path, content) {
  ensureDir(dirname(path));
  if (existsSync(path)) {
    try {
      const existing = readFileSync(path);
      const newBuf = Buffer.isBuffer(content) ? content : Buffer.from(content);
      if (existing.equals(newBuf)) return false;
    } catch {
      // fall through to atomic write
    }
  }
  atomicWrite(path, content);
  return true;
}

// Atomic write via tmp file + rename. Tmp file lives in the same directory
// to ensure rename is atomic across all platforms.
export function atomicWrite(path, content) {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export function readJSON(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return fallback;
  }
}

export function writeJSON(path, obj) {
  return atomicWrite(path, JSON.stringify(obj, null, 2) + '\n');
}

export function writeJSONIfChanged(path, obj) {
  return writeIfChanged(path, JSON.stringify(obj, null, 2) + '\n');
}

export function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

// Atomic O_EXCL lock acquire. Returns null on success; on contention,
// returns a string reason ("held" | "stale-cleared-retry-failed").
//
// Lock content: { pid, started_at, host }. On contention we read the
// holder; if PID is dead OR the lock is older than `staleMs`, reclaim.
export function acquireLock(path, { pid = process.pid, host = '', staleMs = 5 * 60 * 1000 } = {}) {
  ensureDir(dirname(path));
  const payload = JSON.stringify({ pid, started_at: new Date().toISOString(), host });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      try {
        writeSync(fd, payload);
      } finally {
        closeSync(fd);
      }
      return null;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    // Holder exists. Decide whether to reclaim.
    let reclaim = false;
    let holder = null;
    try {
      holder = JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      // unreadable lock — treat as stale.
      reclaim = true;
    }
    if (!reclaim && holder) {
      const sameHost = !holder.host || holder.host === host;
      if (sameHost && typeof holder.pid === 'number') {
        try {
          process.kill(holder.pid, 0);
          // process is alive — not stale.
        } catch (err) {
          if (err.code === 'ESRCH') reclaim = true;
        }
      }
      if (!reclaim && holder.started_at) {
        const ageMs = Date.now() - new Date(holder.started_at).getTime();
        if (ageMs > staleMs) reclaim = true;
      }
    }
    if (!reclaim) return 'held';
    try {
      unlinkSync(path);
    } catch {
      // race: another reclaimer beat us. Retry the loop once.
    }
  }
  return 'stale-cleared-retry-failed';
}

export function releaseLock(path) {
  try {
    unlinkSync(path);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return true;
    throw err;
  }
}

export function readLock(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

export function fileMtimeSize(path) {
  try {
    const st = statSync(path);
    return { mtime: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}
