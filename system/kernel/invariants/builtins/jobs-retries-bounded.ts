import type { RobinDb } from '../../../brain/memory/db.ts';
import type { Invariant } from '../types.ts';

/** Flag a single job that retried at least this many times in the window. The
 *  7-day steady state tops out at ~1-2 retries (an occasional lease overrun or
 *  daemon restart); 10 sits well clear of that floor, so only a genuine outlier
 *  — a job repeatedly outrunning its lease, or a restart storm hammering one row
 *  — trips it. The 54-retry biographer outlier (2026-06-06) is the motivating case. */
const DEFAULT_WARN_RETRIES = 10;
/** Lookback window. Mirrors the 24h scoping used by integration status and the
 *  daily `doctor.run` cadence, so a same-day storm is caught while it's actionable. */
const DEFAULT_WINDOW_HOURS = 24;

interface OffenderRow {
  name: string;
  retry_count: number;
  last_error: string | null;
}

/**
 * Surfaces retry-prone jobs. `retry_count` is only ever bumped by lease recovery
 * (`recoverExpiredLeases` / `recoverDeadWorkerLeases` in scheduler/claim.ts) — a
 * job that outran its lease window or was orphaned by a daemon restart. A normal
 * job retries 0-1×; a row that retried ≥10× is a real signal (a chronically slow
 * job whose lease is too short, or a restart storm). Those recovery paths now
 * stamp a breadcrumb into `last_error` (the cause + worker), so this check can
 * report *why*, not just *that*, a job is retry-prone.
 *
 * Diagnostic only — no `repair()`. The remedy is a code/config change (lengthen
 * the lease, fix the slow handler, stop the restart loop), not a data sweep, so
 * auto-repair would mask the signal. Thresholds are injectable for fast tests.
 */
export function jobsRetriesBoundedInvariant(
  db: RobinDb,
  opts: { warnRetries?: number; windowHours?: number } = {},
): Invariant {
  const warnRetries = opts.warnRetries ?? DEFAULT_WARN_RETRIES;
  const windowHours = opts.windowHours ?? DEFAULT_WINDOW_HOURS;
  const windowModifier = `-${windowHours} hours`;
  return {
    name: 'jobs.retries_bounded',
    severity: 'warning',
    symptom:
      'A scheduled job retries many times before completing — its lease keeps expiring (slow handler / short lease) or a daemon restart storm keeps orphaning it.',
    cause:
      'retry_count is bumped only by lease recovery: the run outran leaseMs, or a restart reset a lease held by a dead worker. Repeated bumps mean a chronic overrun or a restart loop, not a one-off.',
    fix: 'Read the named job\'s last_error breadcrumb. "lease expired" → the handler is slower than the lease window (profile it or raise leaseMs); "worker reset" → the daemon is restarting repeatedly (check launchd / crash logs).',
    check: () => {
      const worst = db
        .prepare(`
        SELECT name, retry_count, last_error
          FROM jobs
         WHERE state IN ('completed', 'errored')
           AND created_at >= datetime('now', ?)
           AND retry_count >= ?
         ORDER BY retry_count DESC, id DESC
         LIMIT 1
      `)
        .get(windowModifier, warnRetries) as OffenderRow | undefined;

      if (!worst) return { ok: true };

      const { offenders } = db
        .prepare(`
        SELECT COUNT(*) AS offenders
          FROM jobs
         WHERE state IN ('completed', 'errored')
           AND created_at >= datetime('now', ?)
           AND retry_count >= ?
      `)
        .get(windowModifier, warnRetries) as { offenders: number };

      const cause = worst.last_error ? `; latest cause: ${worst.last_error}` : '';
      const others =
        offenders > 1 ? ` (${offenders} jobs ≥${warnRetries}× in ${windowHours}h)` : '';
      return {
        ok: false,
        message: `'${worst.name}' retried ${worst.retry_count}× in last ${windowHours}h${others}${cause}`,
        remediation:
          'Inspect the job\'s last_error breadcrumb: "lease expired" → slow handler / short lease; "worker reset" → daemon restart loop.',
      };
    },
  };
}
