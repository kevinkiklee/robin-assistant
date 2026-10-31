import type { RobinDb } from '../../../brain/memory/db.ts';
import { countTerminalJobs, gcStaleTerminalJobs } from '../../../integrations/_runtime/gc.ts';
import type { Invariant } from '../types.ts';

/** Keep this many days of terminal rows — both the daily `retention.run` sweep and
 *  this invariant's repair use it. 24h is the longest real lookback (integration
 *  status scopes errors to 24h), so a week is a generous debug floor. */
export const DEFAULT_RETENTION_DAYS = 7;
/** Warn above this many terminal rows. Observed rate 2026-10: ~3,850 rows/day
 *  (every-minute embedder + biographer, plus integration ticks), so the 7-day window
 *  plus up to a day of accumulation before the daily `retention.run` prune peaks at
 *  ~31k. 50k is ~1.6x that peak: a healthy daemon reports ok, while a ~5-day sweep
 *  outage still trips it. The prune must NOT live only in repair(): the doctor runs
 *  repair only once a check fails, so a repair-only prune let rows grow to the
 *  ceiling every ~13 days (30k fired 18× in 30 days; 50k tripped again 2026-10-16). */
export const DEFAULT_WARN_ROWS = 50_000;

/**
 * The jobs table is append-only at the terminal end: `completeJob` marks rows
 * `completed`/`errored` but never deletes them, and cron re-enqueues a fresh row
 * each tick. Without pruning it grows forever (20k+ rows observed) and old
 * `errored` rows linger as misleading noise. The daily `retention.run` sweep does the
 * routine pruning; this invariant is the alarm for when that sweep stops keeping up.
 * Warn above a ceiling; `repair()` (doctor / `--fix`) prunes terminal rows older than
 * the retention window. Thresholds are injectable so tests stay fast.
 */
export function jobsHistoryBoundedInvariant(
  db: RobinDb,
  opts: { warnRows?: number; retentionDays?: number } = {},
): Invariant {
  const warnRows = opts.warnRows ?? DEFAULT_WARN_ROWS;
  const retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
  return {
    name: 'jobs.history_bounded',
    severity: 'warning',
    symptom:
      'The jobs table grows unboundedly; stale completed/errored rows accumulate and old errors read as current breakage.',
    cause:
      'Terminal job rows are never deleted (completeJob only flips state; cron re-enqueues each tick). No retention sweep was running.',
    fix: `Run \`robin doctor --fix\` (the daily doctor auto-prunes terminal rows older than ${retentionDays} days).`,
    check: () => {
      const n = countTerminalJobs(db);
      if (n <= warnRows) return { ok: true };
      return {
        ok: false,
        message: `${n} terminal job rows (ceiling ${warnRows})`,
        remediation: 'robin doctor --fix',
      };
    },
    repair: () => {
      gcStaleTerminalJobs(db, retentionDays);
    },
  };
}
