// lock-cleanup.js — sweep stale lock files from the locks directory.
//
// PID liveness is the authoritative signal. A live PID is never stale,
// regardless of mtime — long-running jobs (dream, ingest, weekly-review)
// routinely take many minutes; if mtime alone could preempt a lock, the
// next runner would clobber a job mid-flight. mtime is a backstop only:
// used when the lock has no PID (legacy / malformed) so it can still be
// reaped after a process crash that left a corrupt lock behind.
//
// Uses process.kill(pid, 0) to check liveness — throws ESRCH when dead.
// EPERM means the process exists but we can't signal it — treat as alive.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { jobsPaths } from './paths.js';
import { readLock, releaseLock } from './atomic.js';

const DEFAULT_STALE_MS = 5 * 60 * 1000; // 5 minutes — backstop for PID-less locks only

/**
 * Scan <workspaceDir>/user-data/runtime/state/jobs/locks/ and remove stale lock files.
 *
 * @param {string} workspaceDir
 * @param {{ staleMs?: number }} [opts]
 * @returns {{ removed: string[] }}
 */
export function cleanupStaleLocks(workspaceDir, opts = {}) {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const paths = jobsPaths(workspaceDir);
  const locksDir = paths.locksDir;

  if (!existsSync(locksDir)) {
    return { removed: [] };
  }

  const removed = [];
  let entries;
  try {
    entries = readdirSync(locksDir);
  } catch {
    return { removed: [] };
  }

  for (const filename of entries) {
    if (!filename.endsWith('.lock')) continue;
    const lockPath = join(locksDir, filename);

    // statSync first so a vanished file (race between readdir and stat) is a clean skip.
    try {
      statSync(lockPath);
    } catch {
      continue;
    }

    let isStale = false;
    const holder = readLock(lockPath);

    if (holder === null) {
      // Unreadable / corrupt lock — reap it.
      isStale = true;
    } else if (typeof holder.pid === 'number') {
      // PID present — liveness is authoritative.
      try {
        process.kill(holder.pid, 0);
        // alive — keep, regardless of mtime
      } catch (err) {
        if (err.code === 'ESRCH') {
          isStale = true;
        }
        // EPERM: exists but unsignalable → treat as alive
      }
    } else {
      // Lock parsed but has no usable pid field — fall back to mtime backstop.
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) isStale = true;
      } catch {
        continue;
      }
    }

    if (isStale) {
      try {
        releaseLock(lockPath);
        removed.push(filename);
      } catch {
        // Best-effort; ignore removal failures
      }
    }
  }

  return { removed };
}
