import type { RobinDb } from '../../brain/memory/db.ts';

export interface JobRow {
  id: number;
  name: string;
  trigger_kind: string;
  scheduled_at: string;
  leased_until: string | null;
  claimed_by: string | null;
  state: string;
  retry_count: number;
  last_error: string | null;
  payload: string | null;
  created_at: string;
}

export interface EnqueueInput {
  name: string;
  trigger_kind: 'cron' | 'event' | 'hook' | 'delayed' | 'manual';
  scheduled_at: string;
  payload?: unknown;
}

export function enqueueJob(db: RobinDb, input: EnqueueInput): number {
  const stmt = db.prepare(`
    INSERT INTO jobs (name, trigger_kind, scheduled_at, state, payload)
    VALUES (?, ?, ?, 'pending', ?)
  `);
  const result = stmt.run(
    input.name,
    input.trigger_kind,
    input.scheduled_at,
    input.payload === undefined ? null : JSON.stringify(input.payload),
  );
  return Number(result.lastInsertRowid);
}

export interface ClaimOpts {
  workerId: string;
  leaseMs: number;
}

export function claimNextJob(db: RobinDb, opts: ClaimOpts): JobRow | null {
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseUntil = new Date(now.getTime() + opts.leaseMs).toISOString();

  // SQLite doesn't support RETURNING in a single atomic UPDATE prior to 3.35; better-sqlite3 ships a recent SQLite that supports it.
  const stmt = db.prepare(`
    UPDATE jobs
       SET state = 'leased',
           leased_until = ?,
           claimed_by = ?
     WHERE id = (
       SELECT id FROM jobs
        WHERE state = 'pending'
          AND scheduled_at <= ?
        ORDER BY scheduled_at, id
        LIMIT 1
     )
     RETURNING *
  `);
  const row = stmt.get(leaseUntil, opts.workerId, nowIso) as JobRow | undefined;
  return row ?? null;
}

export function completeJob(
  db: RobinDb,
  id: number,
  _outcome: 'ok' | 'error',
  error?: string,
): void {
  if (error) {
    db.prepare(
      `UPDATE jobs SET state = 'errored', last_error = ?, leased_until = NULL, claimed_by = NULL WHERE id = ?`,
    ).run(error, id);
  } else {
    db.prepare(
      `UPDATE jobs SET state = 'completed', leased_until = NULL, claimed_by = NULL WHERE id = ?`,
    ).run(id);
  }
}

export function recoverExpiredLeases(db: RobinDb, nowIso?: string): number {
  const now = nowIso ?? new Date().toISOString();
  // Leave a breadcrumb in last_error so a retried-but-completed row stays
  // diagnosable: retry_count says how often, this says why (the run outran its
  // lease) and which worker/deadline. completeJob('ok') never clears last_error,
  // so it survives a later success — the only writer that overwrites it is a
  // genuine error (which is terminal). Overwrite, not append: the latest cause
  // plus retry_count is enough to triage an outlier without unbounded growth.
  const result = db
    .prepare(`
    UPDATE jobs
       SET state = 'pending',
           last_error = 'lease expired (worker=' || COALESCE(claimed_by, '?')
                        || ', due=' || COALESCE(leased_until, '?') || ')',
           leased_until = NULL,
           claimed_by = NULL,
           retry_count = retry_count + 1
     WHERE state = 'leased' AND leased_until < ?
  `)
    .run(now);
  return result.changes;
}

/**
 * Boot-only sweep: reset any lease NOT held by the current worker, regardless
 * of lease expiry. Pairs with `recoverExpiredLeases` to bridge the gap between
 * a controlled restart (`launchctl kickstart -k`) and the predecessor's lease
 * expiring naturally — without this, the new daemon waits up to LEASE_MS idle.
 *
 * Single-worker safety: in a single-daemon deployment, any `claimed_by` that
 * isn't us is by definition stale. If a future deployment runs multiple
 * concurrent workers, call this with care (or not at all).
 */
export function recoverDeadWorkerLeases(db: RobinDb, currentWorkerId: string): number {
  // Breadcrumb mirrors recoverExpiredLeases: name the predecessor worker that
  // orphaned the lease (almost always a daemon restart), so a restart-storm is
  // distinguishable from genuine lease-timeout overruns after the fact.
  const result = db
    .prepare(`
    UPDATE jobs
       SET state = 'pending',
           last_error = 'worker reset (was=' || COALESCE(claimed_by, '?')
                        || ', now=' || ? || ')',
           leased_until = NULL,
           claimed_by = NULL,
           retry_count = retry_count + 1
     WHERE state = 'leased' AND claimed_by != ?
  `)
    .run(currentWorkerId, currentWorkerId);
  return result.changes;
}
