import type { RobinDb } from '../../../brain/memory/db.ts';
import { countTerminalJobs, gcStaleTerminalJobs } from '../../../integrations/_runtime/gc.ts';
import type { Invariant } from '../types.ts';

/** Repair keeps this many days of terminal rows. 24h is the longest real lookback
 *  (integration status scopes errors to 24h), so a week is a generous debug floor. */
const DEFAULT_RETENTION_DAYS = 7;
/** Warn above this many terminal rows. The 7-day steady state is ~16k (embedder +
 *  biographer run every minute), so 30k sits ~2x above it: a healthy daemon (daily
 *  doctor prunes) reports ok and only a multi-day sweep outage trips the warning. */
const DEFAULT_WARN_ROWS = 30_000;

/**
 * The jobs table is append-only at the terminal end: `completeJob` marks rows
 * `completed`/`errored` but never deletes them, and cron re-enqueues a fresh row
 * each tick. Without pruning it grows forever (20k+ rows observed) and old
 * `errored` rows linger as misleading noise. Mirrors `db.wal_size_bounded`: warn
 * above a ceiling, `repair()` (daily doctor / `--fix`) prunes terminal rows older
 * than the retention window. Thresholds are injectable so tests stay fast.
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
