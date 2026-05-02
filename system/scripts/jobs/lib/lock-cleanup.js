// lock-cleanup.js — sweep stale lock files from the locks directory.
//
// A lock is stale when:
//   a) Its mtime is older than staleMs (default 5 min), OR
//   b) The PID recorded inside the lock file is no longer running.
//
// Uses process.kill(pid, 0) to check liveness — throws ESRCH when dead.
// Leverages readLock / releaseLock from atomic.js to avoid reinventing
// JSON parse / unlink logic.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { jobsPaths } from './paths.js';
import { readLock, releaseLock } from './atomic.js';

const DEFAULT_STALE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Scan <workspaceDir>/user-data/state/jobs/locks/ and remove stale lock files.
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

    let isStale = false;

    // Check mtime first (cheap, no JSON parse needed)
    try {
      const st = statSync(lockPath);
      if (Date.now() - st.mtimeMs > staleMs) {
        isStale = true;
      }
    } catch {
      // File vanished between readdir and statSync — skip
      continue;
    }

    // If not stale by mtime, check whether the PID is still alive
    if (!isStale) {
      const holder = readLock(lockPath);
      if (holder && typeof holder.pid === 'number') {
        try {
          process.kill(holder.pid, 0);
          // PID is alive — not stale
        } catch (err) {
          if (err.code === 'ESRCH') {
            isStale = true;
          }
          // EPERM means the process exists but we can't signal it — treat as alive
        }
      } else if (holder === null) {
        // Unreadable / corrupt lock — treat as stale
        isStale = true;
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
