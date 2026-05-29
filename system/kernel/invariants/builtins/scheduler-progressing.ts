import type { RobinDb } from '../../../brain/memory/db.ts';
import { loadPolicies } from '../../config/load.ts';
import type { Invariant } from '../types.ts';

// The 2026-05-28 incident: Robin sat `paused` for ~22h, so the scheduler claimed
// nothing — nightly cognition (dream, daily-brief) silently skipped and every
// integration went stale. Nothing alarmed, because the only liveness signal was
// `daemon.heartbeating`, which tracks loop *iterations* (updated even while paused)
// rather than *work done*. This invariant closes that gap.
//
// Signal: jobs.created_at is only written when the scheduler does real work — a cron
// reschedule after completion, or the first seed of a new schedule. It is NEVER
// refreshed by a bare restart (scheduleCronJob updates existing rows in place), so
// MAX(created_at) freezes the moment the scheduler stops making progress — whether
// the cause is a pause (no claims) or a wedged handler (no completions) — and stays
// frozen across the daemon restarts that happen constantly. That makes it a
// restart-durable "scheduler last did something" clock with no schema change and no
// per-tick write. It stays fresh during a healthy backlog drain (completions create
// rows), so it does not false-positive while recovering.
const DEFAULT_STALL_MS = 3 * 60 * 60 * 1000; // 3h: well past any legit gap (shortest cron is */1)

export interface SchedulerProgressOptions {
  /** user-data dir, for reading power state to enrich the message. */
  userData: string;
  /** Override the stall threshold (tests). */
  stallThresholdMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

export function schedulerProgressingInvariant(
  db: RobinDb,
  opts: SchedulerProgressOptions,
): Invariant {
  const threshold = opts.stallThresholdMs ?? DEFAULT_STALL_MS;
  const now = opts.now ?? (() => Date.now());
  return {
    name: 'scheduler.progressing',
    severity: 'critical',
    symptom:
      'No scheduled job has run for hours: integrations stop syncing and nightly cognition (dream, daily-brief) is silently skipped while the daemon still looks healthy.',
    cause:
      "Robin is paused (power.state != 'active') and was never resumed — e.g. a manual pause that was forgotten, or an auto-pause that failed to auto-resume — or a job handler is wedged so the single-worker loop never advances.",
    fix: 'If paused: `robin resume`. If active: the scheduler loop is stuck on a handler — restart the daemon (`launchctl kickstart -k gui/$(id -u)/io.robin-assistant.daemon`).',
    check: () => {
      try {
        const row = db.prepare('SELECT MAX(created_at) AS last FROM jobs').get() as
          | { last: string | null }
          | undefined;
        // No jobs yet (fresh install) — nothing to be stale about.
        if (!row?.last) return { ok: true };
        // jobs.created_at is SQLite CURRENT_TIMESTAMP: 'YYYY-MM-DD HH:MM:SS' in UTC.
        const lastMs = Date.parse(`${row.last.replace(' ', 'T')}Z`);
        if (Number.isNaN(lastMs)) return { ok: true };

        const idleMs = now() - lastMs;
        if (idleMs <= threshold) return { ok: true };

        const hours = (idleMs / 3_600_000).toFixed(1);
        let state = 'active';
        let setBy: string | undefined;
        try {
          const p = loadPolicies(opts.userData);
          state = p.power.state;
          setBy = p.power.set_by;
        } catch {
          // policies unreadable — fall through with defaults
        }

        const paused = state !== 'active';
        return {
          ok: false,
          message: paused
            ? `scheduler idle ${hours}h — power is '${state}'${setBy ? ` (set_by:${setBy})` : ''}; scheduled work is halted`
            : `scheduler idle ${hours}h while active — a job handler is likely wedged`,
          remediation: paused ? 'robin resume' : 'restart daemon',
        };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
