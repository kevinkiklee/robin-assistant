import type { RobinDb } from '../../../brain/memory/db.ts';
import { pruneResolvedAlerts } from '../../runtime/alert-store.ts';
import type { Invariant } from '../types.ts';

/** Repair keeps this many days of resolved alert rows. */
const DEFAULT_RETENTION_DAYS = 30;
/** Warn above this many resolved rows. Resolved alerts accumulate silently;
 *  10k is a generous ceiling that only trips if pruning has been absent for
 *  an extended period. */
const DEFAULT_WARN_ROWS = 10_000;

/**
 * The alerts table accumulates resolved rows indefinitely without pruning.
 * Resolved alerts carry no operational value once they age past the retention
 * window, but they grow the DB and add noise to history queries. Warn above a
 * ceiling; `repair()` (daily doctor / `robin doctor --fix`) prunes resolved
 * rows older than the retention window. Thresholds are injectable so tests
 * stay fast.
 */
export function alertsHistoryBoundedInvariant(
  db: RobinDb,
  opts: { warnRows?: number; retentionDays?: number } = {},
): Invariant {
  const warnRows = opts.warnRows ?? DEFAULT_WARN_ROWS;
  const retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
  return {
    name: 'alerts.history_bounded',
    severity: 'warning',
    symptom:
      'The alerts table grows unboundedly; resolved alert rows accumulate and inflate the database without providing operational value.',
    cause:
      'Resolved alert rows are never deleted (resolveAlert only sets resolved_at; no retention sweep was running).',
    fix: `Run \`robin doctor --fix\` (the daily doctor auto-prunes resolved alerts older than ${retentionDays} days).`,
    check: () => {
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM alerts WHERE resolved_at IS NOT NULL`)
        .get() as { n: number };
      const n = row.n;
      if (n <= warnRows) return { ok: true };
      return {
        ok: false,
        message: `${n} resolved alert rows (ceiling ${warnRows})`,
        remediation: 'robin doctor --fix',
      };
    },
    repair: () => {
      pruneResolvedAlerts(db, retentionDays);
    },
  };
}
