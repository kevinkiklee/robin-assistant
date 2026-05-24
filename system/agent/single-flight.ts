import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** On-disk shape of a held lock: the holder's pid + acquisition timestamp (ms). */
interface LockBody {
  pid: number;
  ts: number;
}

export interface AcquireOpts {
  /**
   * A lock older than `staleMs` is considered abandoned and stolen. This guards
   * against a crashed/killed holder leaving the lock wedged forever — there is no
   * release-on-exit guarantee for a detached child.
   */
  staleMs: number;
  /** Injected for tests; defaults to wall-clock ms. */
  now?: () => number;
  /** Injected for tests; defaults to this process's pid. */
  pid?: number;
}

/** Best-effort read of an existing lock body. Returns null on missing/corrupt. */
function readLock(lockPath: string): LockBody | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<LockBody>;
    if (typeof parsed.pid === 'number' && typeof parsed.ts === 'number') {
      return { pid: parsed.pid, ts: parsed.ts };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Single-flight lockfile. `acquire` writes `{pid, ts}` and returns true; if a
 * fresh lock (younger than `staleMs`) is already held it returns false without
 * touching it. A stale lock is stolen (overwritten) and acquisition succeeds.
 *
 * Intentionally simple — not crash-safe against a concurrent writer racing in
 * the same millisecond. The only writers are the once-per-tick agent-runner job
 * and an operator's manual run, so contention is effectively zero; the staleMs
 * steal is the real safety net against an abandoned lock.
 */
export function acquire(lockPath: string, opts: AcquireOpts): boolean {
  const now = opts.now ?? (() => Date.now());
  const pid = opts.pid ?? process.pid;
  const existing = readLock(lockPath);
  if (existing && now() - existing.ts < opts.staleMs) {
    // A fresh lock is held by someone else — back off.
    return false;
  }
  // No lock, or a stale one we may steal.
  const body: LockBody = { pid, ts: now() };
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, JSON.stringify(body), 'utf8');
  return true;
}

/** Release the lock. Best-effort: a missing file is not an error. */
export function release(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // already gone — nothing to do
  }
}
