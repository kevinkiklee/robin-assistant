import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { RobinDb } from '../brain/memory/db.ts';

export type VerifierResult = 'pass' | 'fail' | 'unverifiable';

export interface VerifierDeps {
  db: RobinDb;
  /** ISO timestamp captured immediately before runAgent was invoked. */
  runStartIso: string;
  /** Absolute path to user-data/content/knowledge (D/G check it for changed files). */
  knowledgeDir: string;
  /** The run's worktree, when one was created (K). */
  worktree?: string;
  /** K's diff check. REQUIRED so this module stays free of git — the caller
   * (runner-entry) passes the real `worktreeHasChanges`; tests pass a fake. */
  worktreeHasChanges: (worktree: string) => boolean;
}

/** True when any row of `table` has `datetime(col) >= datetime(runStart)`. Both
 * sqlite ('YYYY-MM-DD HH:MM:SS') and JS ISO ('...T...Z') formats parse as UTC.
 * `table`/`col` come only from the literal switch below, never caller input. */
function rowsSince(
  db: RobinDb,
  table: string,
  col: string,
  runStartIso: string,
  extra = '',
): boolean {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE datetime(${col}) >= datetime(?) ${extra}`)
    .get(runStartIso) as { n: number };
  return row.n > 0;
}

/** True when any file under `dir` (recursive) was modified at/after runStart. */
function filesChangedSince(dir: string, runStartIso: string): boolean {
  const cutoff = Date.parse(runStartIso);
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    const p = join(e.parentPath, e.name);
    if (statSync(p).mtimeMs >= cutoff) return true;
  }
  return false;
}

/**
 * Deterministic post-condition check per handler (spec §B3) — no LLM. 'pass'
 * means the handler's claimed work is observable in the world; 'fail' means a
 * did-work claim could not be confirmed (the caller records `outcome-mismatch`
 * and fires a Phase-A alert). Handlers without a checkable post-condition (L)
 * and verifier crashes are 'unverifiable' — never thrown.
 */
export function verifyOutcome(handlerId: string, deps: VerifierDeps): VerifierResult {
  try {
    switch (handlerId) {
      case 'B':
        return rowsSince(deps.db, 'events', 'ts', deps.runStartIso, `AND kind='research.brief'`)
          ? 'pass'
          : 'fail';
      case 'D':
      case 'G':
        return filesChangedSince(deps.knowledgeDir, deps.runStartIso) ? 'pass' : 'fail';
      case 'E':
        // E proposes via `believe` (which appends a belief.update truth-stream
        // event — NOT a belief_candidates row) OR records a correction. The
        // belief_candidates check is kept for back-compat with any candidate
        // routing, but the primary evidence of a `believe` call is the event.
        return rowsSince(deps.db, 'events', 'ts', deps.runStartIso, `AND kind='belief.update'`) ||
          rowsSince(deps.db, 'belief_candidates', 'created_at', deps.runStartIso) ||
          rowsSince(deps.db, 'corrections', 'ts', deps.runStartIso)
          ? 'pass'
          : 'fail';
      case 'H':
        // H's ONLY write tool is `believe`, which appends a belief.update event
        // and can never write a belief_candidates row — so verifying against
        // candidates alone structurally fails every legitimate H run (the source
        // of the recurring `outcome-mismatch:H` alert). Count the belief.update
        // event as the real post-condition; keep the candidates check for back-compat.
        return rowsSince(deps.db, 'events', 'ts', deps.runStartIso, `AND kind='belief.update'`) ||
          rowsSince(deps.db, 'belief_candidates', 'created_at', deps.runStartIso)
          ? 'pass'
          : 'fail';
      case 'F':
        return rowsSince(deps.db, 'predictions', 'resolved_at', deps.runStartIso) ? 'pass' : 'fail';
      case 'K':
        return deps.worktree && deps.worktreeHasChanges(deps.worktree) ? 'pass' : 'fail';
      default:
        return 'unverifiable'; // L (read-only brief) and unknown ids
    }
  } catch {
    return 'unverifiable';
  }
}
