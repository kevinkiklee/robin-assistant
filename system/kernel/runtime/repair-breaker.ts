import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Persistent circuit breaker for invariant repairs (reliability spec section B).
 * A repair that keeps failing must not be retried forever — once it has failed
 * TRIP_THRESHOLD times in a row *for the currently running build*, `isRepairBroken`
 * trips and the monitor stops calling `repair()` for that invariant. State lives
 * in a small JSON file under `<userData>/state/runtime/repair-breaker.json`, so a
 * daemon restart mid-incident doesn't forget a tripped breaker — the same
 * durability discipline as `boots.json` for daemon-stable. Every read/write is
 * best-effort: I/O failure (missing dir, corrupt JSON, disk full) must never
 * break the health monitor tick, so it's swallowed and treated as "not broken" /
 * "write skipped".
 *
 * SHA-keyed: a failure streak only counts against the build SHA it happened on.
 * A differing (or absent) recorded SHA is never treated as "the same streak" as
 * the SHA being asked about now — deploying new code always gets a clean slate
 * rather than inheriting an old build's (or a sha-less entry's) failure count.
 */

interface BreakerEntry {
  failures: number;
  sha: string;
  lastFailureAt: string;
}

type BreakerState = Record<string, BreakerEntry>;

// Reconciled per the task-1 review: broken at 2 consecutive failures on the
// current build SHA — not 3, and not a lifetime-per-name count.
const TRIP_THRESHOLD = 2;

function breakerPath(userDataDir: string): string {
  return join(userDataDir, 'state', 'runtime', 'repair-breaker.json');
}

function readState(userDataDir: string): BreakerState {
  try {
    const raw = JSON.parse(readFileSync(breakerPath(userDataDir), 'utf8'));
    return raw && typeof raw === 'object' ? (raw as BreakerState) : {};
  } catch {
    return {};
  }
}

function writeState(userDataDir: string, state: BreakerState): void {
  const p = breakerPath(userDataDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2));
}

/**
 * Current build SHA, read fresh from `dist/.build-stamp` (first line; missing
 * or unreadable → 'dev'). Anchored to the repo root via THIS module's own file
 * location (three levels up from `system/kernel/runtime/`) rather than
 * `process.cwd()` — the daemon's cwd is `user-data/` under launchd.
 *
 * Task 3 (reliability step 3, lane B) ships a shared `readBuildStamp` at
 * `system/lib/build-stamp.ts` for this same purpose. That module isn't in this
 * worktree, so this is a deliberately small local duplicate to keep the two
 * lanes' diffs disjoint.
 *
 * merge note: swap to readBuildStamp from system/lib/build-stamp.ts (lane B) if desired post-merge
 */
export function currentSha(): string {
  try {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const raw = readFileSync(join(repoRoot, 'dist', '.build-stamp'), 'utf8');
    const firstLine = raw.split('\n')[0]?.trim();
    return firstLine || 'dev';
  } catch {
    return 'dev';
  }
}

/**
 * True once `name`'s repair has failed >= TRIP_THRESHOLD times in a row *on the
 * given build SHA*. `sha` defaults to `currentSha()` when omitted — production
 * callers driving many invariants in one tick should read it once themselves
 * and pass it explicitly, to avoid re-reading the stamp file per invariant.
 * An entry recorded under a different (or missing) SHA than the one being
 * asked about is a fresh start: not broken, regardless of its failure count.
 */
export function isRepairBroken(userDataDir: string, name: string, sha?: string): boolean {
  const resolvedSha = sha ?? currentSha();
  const entry = readState(userDataDir)[name];
  if (!entry) return false;
  if (entry.sha !== resolvedSha) return false;
  return entry.failures >= TRIP_THRESHOLD;
}

/**
 * Record one repair failure for `name`, persisted immediately so it survives a
 * daemon restart. `sha` defaults to `currentSha()` when omitted. A streak only
 * continues when the previously recorded SHA matches the resolved one exactly
 * — a differing (or absent) prior SHA always resets the count to 1, so a new
 * build never inherits an old build's failures, nor an old sha-less entry's.
 */
export function recordRepairFailure(userDataDir: string, name: string, sha?: string): void {
  try {
    const resolvedSha = sha ?? currentSha();
    const state = readState(userDataDir);
    const prev = state[name];
    const sameStreak = prev?.sha === resolvedSha;
    state[name] = {
      failures: sameStreak ? prev.failures + 1 : 1,
      sha: resolvedSha,
      lastFailureAt: new Date().toISOString(),
    };
    writeState(userDataDir, state);
  } catch {
    // best-effort — breaker bookkeeping must never break the health monitor tick
  }
}
