import type { RobinDb } from '../../../brain/memory/db.ts';
import type { Invariant } from '../types.ts';

/** Warn above this many bytes of embeddings on terminal candidate rows. A day's
 *  resolutions (~50–100 rows × ~8 KB vectors) stays well under 1 MB, so 8 MB only
 *  trips after a multi-day sweep outage — mirrors jobs.history_bounded's 2× logic. */
const DEFAULT_WARN_BYTES = 8 * 1024 * 1024;

/** Statuses whose embeddings are provably dead weight. Both embedding readers
 *  (`matchAndCorroborate` and `dedupePendingCandidates` in belief-candidate.ts)
 *  select `WHERE status = 'pending'` only. `conflicted` rows are deliberately
 *  excluded: they await review/re-proposal and are few (expireStaleConflicts
 *  rejects them at 30 days, at which point this sweep catches them as 'rejected'). */
const TERMINAL_STATUSES = ['promoted', 'rejected', 'merged'] as const;

/**
 * Candidate embeddings (~8 KB float32 blobs) exist to dedupe/corroborate PENDING
 * rows; resolution never cleared them, so 10.6k promoted/rejected/merged rows
 * accrued ~84 MB (~12% of the whole DB) by 2026-08-31. Repair nulls the blob on
 * terminal rows — the claim text, status, and audit trail stay intact, and a
 * re-embed is always possible from the claim. Freed pages return to SQLite's
 * freelist (file shrink needs a one-time VACUUM). Threshold injectable for tests.
 */
export function beliefEmbeddingsBoundedInvariant(
  db: RobinDb,
  opts: { warnBytes?: number } = {},
): Invariant {
  const warnBytes = opts.warnBytes ?? DEFAULT_WARN_BYTES;
  const inList = TERMINAL_STATUSES.map((s) => `'${s}'`).join(', ');
  return {
    name: 'beliefs.embeddings_bounded',
    severity: 'warning',
    symptom:
      'belief_candidates carries embedding blobs on resolved rows, inflating the DB with vectors nothing reads.',
    cause:
      "Embeddings are attached at draft/dedupe time for pending-row matching, but resolution (promote/reject/merge) never nulled them; every reader is scoped to status='pending'.",
    fix: 'Run `robin doctor --fix` (the daily doctor nulls embeddings on promoted/rejected/merged rows).',
    check: () => {
      const row = db
        .prepare(
          `SELECT count(*) AS n, COALESCE(sum(length(embedding)), 0) AS bytes
             FROM belief_candidates
            WHERE status IN (${inList}) AND embedding IS NOT NULL`,
        )
        .get() as { n: number; bytes: number };
      if (row.bytes <= warnBytes) return { ok: true };
      return {
        ok: false,
        message: `${(row.bytes / 1048576).toFixed(1)}MB of embeddings on ${row.n} resolved candidate rows (ceiling ${(warnBytes / 1048576).toFixed(0)}MB)`,
        remediation: 'robin doctor --fix',
      };
    },
    repair: () => {
      db.prepare(
        `UPDATE belief_candidates SET embedding = NULL
          WHERE status IN (${inList}) AND embedding IS NOT NULL`,
      ).run();
    },
  };
}
