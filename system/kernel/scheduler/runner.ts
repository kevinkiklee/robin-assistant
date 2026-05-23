import type { RobinDb } from '../../brain/memory/db.ts';
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
      await handler(job);
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
