import type { RobinDb } from '../../../brain/memory/db.ts';
import type { Invariant } from '../types.ts';

/** Repair keeps this many days of recall telemetry. The value-loops replay
 *  program samples RECENT prompts, and 180 days is far beyond any replay or
 *  calibration window in use — bounding the future without touching the
 *  analytical horizon (the store was 102 days deep when this shipped). */
const DEFAULT_RETENTION_DAYS = 180;
/** Warn above this many rows. ~750 rows/day steady state → 150k ≈ 200 days,
 *  so a healthy daily-doctor cadence never warns; only a sweep outage trips it. */
const DEFAULT_WARN_ROWS = 150_000;

/**
 * recall_log is append-only telemetry (one row per recall query since May 2026;
 * 71k rows / 33 MB by 08-31) with no retention sweep — the only unbounded table
 * left after jobs/alerts/session-state got theirs. Mirrors those invariants:
 * warn above a row ceiling; `repair()` (daily doctor / `--fix`) prunes rows
 * older than the retention window. `recall_log_outcome` is an index on this
 * table, so a single DELETE covers everything. Thresholds injectable for tests.
 */
export function recallLogBoundedInvariant(
  db: RobinDb,
  opts: { warnRows?: number; retentionDays?: number } = {},
): Invariant {
  const warnRows = opts.warnRows ?? DEFAULT_WARN_ROWS;
  const retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
  return {
    name: 'recall.history_bounded',
    severity: 'warning',
    symptom:
      'recall_log grows unboundedly; years of per-query telemetry inflate the DB long after any replay window needs them.',
    cause:
      'Every recall (auto + manual) appends a row and nothing ever pruned them; jobs/alerts/session-state got retention sweeps, recall_log did not.',
    fix: `Run \`robin doctor --fix\` (the daily doctor prunes recall_log rows older than ${retentionDays} days).`,
    check: () => {
      const row = db.prepare(`SELECT count(*) AS n FROM recall_log`).get() as { n: number };
      if (row.n <= warnRows) return { ok: true };
      return {
        ok: false,
        message: `${row.n} recall_log rows (ceiling ${warnRows})`,
        remediation: 'robin doctor --fix',
      };
    },
    repair: () => {
      db.prepare(`DELETE FROM recall_log WHERE ts < datetime('now', ?)`).run(
        `-${retentionDays} days`,
      );
    },
  };
}
