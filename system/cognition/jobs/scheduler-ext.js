import { surql } from 'surrealdb';
import { log } from '../../runtime/log/index.js';
import { expectedIntervalMs, nextFire, parseCron } from './cron.js';
import { getJob, recordFailure, recordSuccess, setNextRunAt } from './db.js';

const CATCHUP_FACTOR = 1.5;

/**
 * Wrap a heartbeat-bucket tick so it updates `runtime_jobs` on every fire.
 *
 * Heartbeat-driven jobs (those declared with `scheduler_driven: true` in their
 * markdown manifest, e.g. `state-inference`) bypass the generic jobs runner —
 * the bucket in `runtime/daemon/server.js` calls their function directly. That
 * means `runtime_jobs.last_run_at` / `next_run_at` / `last_run_ok` never get
 * updated, so `robin jobs list` (and `mcp__robin__list_jobs`) appear to show
 * a stuck job even when telemetry confirms it's firing on cadence.
 *
 * This helper preserves the bucket's existing throw semantics (the scheduler's
 * own try/catch still logs `[scheduler/<name>] tick failed: …`), but writes
 * a row-level success/failure record before propagating. The `recordSuccess`
 * / `recordFailure` writers no-op silently when the named row doesn't exist
 * — safe to wrap any tick whose name might not correspond to a runtime_jobs
 * row.
 *
 * `intervalMs` is the bucket's cadence; `next_run_at` is computed as
 * `now + intervalMs`, matching the heartbeat's actual cadence rather than
 * the markdown cron. That keeps the displayed `next_run_at` accurate even
 * when the job's `tick_ms` is overridden in `runtime:<name>.config`.
 */
export function withRuntimeJobsTracking(db, name, intervalMs, fn) {
  return async function trackedTick() {
    const start = Date.now();
    try {
      const out = await fn();
      const duration_ms = Date.now() - start;
      const next_run_at = new Date(Date.now() + intervalMs);
      try {
        await recordSuccess(db, name, { duration_ms, next_run_at });
      } catch (e) {
        // Tracking is best-effort. A failed write must not turn a successful
        // tick into a failure — log and continue.
        log.warn({
          event: 'scheduler.tracking_write_failed',
          job: name,
          message: e.message,
          error: e.code ?? e.name,
        });
      }
      return out;
    } catch (e) {
      const duration_ms = Date.now() - start;
      const next_run_at = new Date(Date.now() + intervalMs);
      try {
        await recordFailure(db, name, { error: e.message, duration_ms, next_run_at });
      } catch (te) {
        log.warn({
          event: 'scheduler.tracking_write_failed',
          job: name,
          message: te.message,
          error: te.code ?? te.name,
        });
      }
      throw e;
    }
  };
}

export async function planNextRunAt(db, jobs, now = new Date()) {
  for (const j of jobs) {
    const row = await getJob(db, j.name);
    if (!row?.enabled) continue;
    let parsed;
    try {
      parsed = parseCron(j.schedule);
    } catch (e) {
      log.warn({
        event: 'jobs.bad_schedule',
        job: j.name,
        schedule: j.schedule,
        message: e.message,
        error: e.code ?? e.name,
      });
      continue;
    }

    const lastRunAt = row.last_run_at ? new Date(row.last_run_at) : null;

    if (lastRunAt == null) {
      // First-ever fire.
      const target = j.catch_up ? new Date(now) : nextFire(parsed, now);
      await setNextRunAt(db, j.name, target);
      continue;
    }

    const intervalMs = expectedIntervalMs(parsed, now);
    const behindMs = now.getTime() - lastRunAt.getTime();
    if (behindMs > CATCHUP_FACTOR * intervalMs && j.catch_up) {
      await setNextRunAt(db, j.name, new Date(now));
    } else if (!row.next_run_at) {
      await setNextRunAt(db, j.name, nextFire(parsed, now));
    }
  }
}

export async function listDueJobs(db, now = new Date()) {
  // scheduler_driven jobs are documented in the jobs registry but dispatched
  // by a dedicated heartbeat bucket in runtime/daemon/server.js, not by the
  // generic jobs runner — exclude them here to avoid double-fire.
  const [rows] = await db
    .query(
      surql`SELECT name FROM runtime_jobs
            WHERE enabled = true AND in_flight = false AND next_run_at <= ${now}
              AND (scheduler_driven IS NONE OR scheduler_driven = false)
            ORDER BY name`,
    )
    .collect();
  return (rows ?? []).map((r) => ({ name: r.name, kind: 'job' }));
}
