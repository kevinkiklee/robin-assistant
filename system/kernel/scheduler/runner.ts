import type { RobinDb } from '../../brain/memory/db.ts';
import { withTimeout } from '../../lib/with-timeout.ts';
import { claimNextJob, completeJob, type JobRow } from './claim.ts';
import { rescheduleCronAfterCompletion } from './cron.ts';

export type JobHandler = (job: JobRow) => Promise<void> | void;

export interface SchedulerConfig {
  db: RobinDb;
  handlers: Map<string, JobHandler>;
  workerId: string;
  leaseMs: number;
  isPaused: () => boolean;
  onError?: (err: Error, job: JobRow) => void;
  /**
   * Wall-clock ceiling for a single handler invocation. A handler that exceeds
   * it is abandoned (its promise rejected with a TimeoutError) and the job is
   * marked `errored`, so one wedged handler can never stall the sequential tick
   * loop — the failure mode that took the daemon dark for ~31h on 2026-06-02.
   *
   * This is a last-resort *anti-wedge backstop*, deliberately looser than the
   * per-LLM-call SDK timeouts and per-job chunk budgets that are the primary
   * time guards. Cognition handlers are idempotent (cursor/state-based), so an
   * abandoned tick safely resumes on its next cron. Caveat: withTimeout can only
   * unblock an *async-blocked* handler (a hung await); a synchronously
   * CPU-blocked handler freezes the event loop so the timer never fires — that
   * case still relies on the daemon's heartbeat→launchd-respawn backstop.
   *
   * Omit (or pass a non-finite/≤0 value) to disable — handlers then run uncapped.
   */
  handlerTimeoutMs?: number;
}

export class Scheduler {
  constructor(private cfg: SchedulerConfig) {}

  /** Claim and run one pending job, if any. Returns true if a job was run, false if none was available or paused. */
  async tickOnce(): Promise<boolean> {
    if (this.cfg.isPaused()) return false;

    const job = claimNextJob(this.cfg.db, {
      workerId: this.cfg.workerId,
      leaseMs: this.cfg.leaseMs,
    });
    if (!job) return false;

    const handler = this.cfg.handlers.get(job.name);
    if (!handler) {
      completeJob(this.cfg.db, job.id, 'error', `no handler registered for job '${job.name}'`);
      // Even with no handler, re-arm the cron — a missing handler is a startup-order
      // bug we want to keep seeing every tick, not silently disable.
      rescheduleCronAfterCompletion(this.cfg.db, job);
      return true;
    }

    try {
      const timeoutMs = this.cfg.handlerTimeoutMs;
      if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0) {
        await withTimeout(
          Promise.resolve(handler(job)),
          timeoutMs,
          `job '${job.name}' handler exceeded ${timeoutMs}ms`,
        );
      } else {
        await handler(job);
      }
      completeJob(this.cfg.db, job.id, 'ok');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      completeJob(this.cfg.db, job.id, 'error', message);
      this.cfg.onError?.(err instanceof Error ? err : new Error(message), job);
    }
    // Re-arm cron-triggered jobs regardless of success/error so transient handler
    // failures don't permanently silence a recurring schedule. Non-cron rows
    // (event/hook/delayed/manual) are no-ops inside `rescheduleCronAfterCompletion`.
    rescheduleCronAfterCompletion(this.cfg.db, job);
    return true;
  }
}
