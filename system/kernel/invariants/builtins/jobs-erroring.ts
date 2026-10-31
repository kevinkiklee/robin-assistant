import type { RobinDb } from '../../../brain/memory/db.ts';
import type { Invariant } from '../types.ts';

/**
 * Transient-failure signature match, applied in JS (not SQL LIKE) so word
 * boundaries are exact: `LIKE '%502%'` also matched an unrelated string like
 * "offset 15023" (the substring "502" sits mid-digit-run there), a false
 * positive that would requeue a job for a failure it never actually had.
 * `\b...\b` anchors each alternative to real token boundaries instead.
 */
const TRANSIENT_ERROR_RE =
  /\b(50[234]|fetch failed|timeout|ECONNRESET|ETIMEDOUT|socket hang up)\b/i;

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
    dependsOn: ['daemon.stable', 'daemon.heartbeating'],
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
              GROUP BY name ORDER BY name`,
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
    // Bounded transient requeue: only rows whose `last_error` matches a known
    // transient-failure signature (network blip, timeout, upstream 5xx) are
    // reset — an unrecognized signature (a real bug) is left `errored` so the
    // human-visible alert stays accurate. `retry_count < 5` is a hard ceiling:
    // a job that has already retried 5 times is treated as genuinely stuck,
    // not transient, regardless of how sympathetic its error message looks.
    //
    // `retry_count < 5` plus the 24h window stay in SQL (cheap, bounds the
    // set before it ever reaches JS); the signature match itself runs in JS
    // via TRANSIENT_ERROR_RE over that bounded set, for exact word-boundary
    // semantics (see the regex's doc comment above).
    repair: () => {
      const candidates = db
        .prepare(
          `SELECT id, last_error FROM jobs
            WHERE state='errored'
              AND created_at > datetime('now','-1 day')
              AND retry_count < 5`,
        )
        .all() as Array<{ id: number; last_error: string | null }>;
      const ids = candidates
        .filter((r) => r.last_error !== null && TRANSIENT_ERROR_RE.test(r.last_error))
        .map((r) => r.id);
      if (ids.length === 0) return;
      // Cron double-pending note: `rescheduleCronAfterCompletion` already
      // re-arms a cron-triggered job's NEXT scheduled occurrence the moment it
      // errors (system/kernel/scheduler/runner.ts's tickOnce, and the detached
      // cognition-child completion path both call it "regardless of
      // success/error so transient handler failures don't permanently silence
      // a recurring schedule"). Flipping THIS same row back to `pending` here
      // therefore intentionally risks a second pending row for the same cron
      // name — one already re-armed for the next tick, one from this
      // immediate retry. That's accepted: the scheduler claims rows FIFO by
      // `scheduled_at`, so the extra row just means this cron name gets
      // claimed twice in close succession rather than duplicating or
      // blocking any other work, and that's strictly better than leaving a
      // genuine transient failure stuck until the next natural cron fire.
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(
        `UPDATE jobs SET state='pending', scheduled_at=datetime('now') WHERE id IN (${placeholders})`,
      ).run(...ids);
    },
  };
}
