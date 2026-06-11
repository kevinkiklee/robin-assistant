import type { RobinDb } from '../../../brain/memory/db.ts';
import type { Invariant } from '../types.ts';

/**
 * Flags job names that have landed in the `errored` state within the last 24
 * hours. A single errored row after a transient blip is acceptable noise, but
 * a recurring job that errors every tick is a real failure that the operator
 * needs to know about.
 *
 * `warning` severity: one errored run does not take the daemon down. The
 * message includes per-name counts so the alert wiring (Task 8) can surface
 * the worst offenders without further DB round-trips.
 */
export function jobsErroringInvariant(db: RobinDb): Invariant {
  return {
    name: 'jobs.not_erroring',
    severity: 'warning',
    symptom: 'One or more scheduled jobs have errored within the last 24 hours.',
    cause:
      'A job handler threw an unhandled exception or timed out; the scheduler marked the row `errored`. Common roots: integration fault, LLM timeout, or a bug in a user job.',
    fix: 'Run `robin doctor` to see which jobs are failing; check the daemon log (`user-data/observability/logs/daemon.log`) for the root exception.',
    check: () => {
      try {
        const rows = db
          .prepare(
            `SELECT name, COUNT(*) AS n FROM jobs
              WHERE state='errored' AND created_at > datetime('now','-1 day')
              GROUP BY name`,
          )
          .all() as Array<{ name: string; n: number }>;
        if (rows.length === 0) return { ok: true };
        return {
          ok: false,
          message: rows.map((r) => `${r.name} errored ${r.n}× in 24h`).join('; '),
          remediation: 'robin doctor; check daemon logs for the failing job',
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
