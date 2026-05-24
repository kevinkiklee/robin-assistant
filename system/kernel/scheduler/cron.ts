import { CronExpressionParser } from 'cron-parser';
import type { RobinDb } from '../../brain/memory/db.ts';

/**
 * Resolve the timezone a cron expression should be interpreted in.
 *
 * Precedence: explicit caller arg → `ROBIN_TZ` env → system IANA TZ → UTC fallback.
 *
 * Why this isn't just "UTC always" — a user-facing schedule like `30 5-8 * * *`
 * ("between 5:30 and 8:30 every morning") is naturally local. Interpreting in UTC
 * silently fires the job in the middle of the user's night. Defaulting to system TZ
 * matches the principle of least surprise; manifests can override via `tz:` for
 * tasks that legitimately need wall-clock UTC (e.g. coordinating with an external
 * batch window).
 */
export function resolveTz(tz?: string): string {
  if (tz) return tz;
  const envTz = process.env.ROBIN_TZ;
  if (envTz) return envTz;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function getNextRunAt(cron: string, from: Date, tz?: string): Date {
  const it = CronExpressionParser.parse(cron, { currentDate: from, tz: resolveTz(tz) });
  return it.next().toDate();
}

export interface CronJobSpec {
  name: string;
  cron: string;
  /** IANA timezone the cron expression is interpreted in. Defaults via resolveTz(). */
  tz?: string;
}

/**
 * Payload shape persisted on cron-triggered rows so `rescheduleCronAfterCompletion`
 * can compute the next-run without re-reading any in-memory registry. Keeps the
 * cron schedule travelling with the row across daemon restarts.
 */
export interface CronPayload {
  cron: string;
  tz?: string;
}

export function isCronPayload(value: unknown): value is CronPayload {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.cron === 'string' && (v.tz === undefined || typeof v.tz === 'string');
}

export function scheduleCronJob(db: RobinDb, spec: CronJobSpec, from: Date = new Date()): void {
  const next = getNextRunAt(spec.cron, from, spec.tz);
  const nextIso = next.toISOString();
  const payload: CronPayload = spec.tz ? { cron: spec.cron, tz: spec.tz } : { cron: spec.cron };
  const payloadJson = JSON.stringify(payload);

  // Idempotent: at most one pending row per name. But if the existing pending row's
  // scheduled_at, payload, or trigger_kind doesn't match the recomputed values (e.g.
  // the user changed cron expression, added a `tz:`, the prior schedule was computed
  // under a stale TZ default, or the row was originally inserted manually and is now
  // being adopted by a cron registration), refresh all three. trigger_kind
  // normalization to 'cron' is load-bearing — without it, `rescheduleCronAfterCompletion`
  // returns false for adopted rows and the cron silently fails to re-arm.
  const existing = db
    .prepare(
      `SELECT id, scheduled_at, payload, trigger_kind FROM jobs WHERE name = ? AND state = 'pending'`,
    )
    .get(spec.name) as
    | { id: number; scheduled_at: string; payload: string | null; trigger_kind: string }
    | undefined;

  if (existing) {
    const needsRefresh =
      existing.scheduled_at !== nextIso ||
      existing.payload !== payloadJson ||
      existing.trigger_kind !== 'cron';
    if (needsRefresh) {
      db.prepare(
        `UPDATE jobs SET scheduled_at = ?, payload = ?, trigger_kind = 'cron' WHERE id = ?`,
      ).run(nextIso, payloadJson, existing.id);
    }
    return;
  }

  db.prepare(`
    INSERT INTO jobs (name, trigger_kind, scheduled_at, state, payload)
    VALUES (?, 'cron', ?, 'pending', ?)
  `).run(spec.name, nextIso, payloadJson);
}

/**
 * Called by the scheduler after a cron-triggered job completes (success or error).
 * Parses the row's payload to recover the cron expression, then re-enqueues the
 * next instance. Without this, `scheduleCronJob` would only ever fire once per
 * daemon boot — the cron schedule would be decorative (Bug C).
 *
 * Re-enqueues even on error, because transient handler failures should not
 * permanently silence a cron. `retry_count` on the completed row records the
 * history; an external supervisor can decide to mute after N consecutive errors.
 */
export function rescheduleCronAfterCompletion(
  db: RobinDb,
  job: { name: string; trigger_kind: string; payload: string | null },
  from: Date = new Date(),
): boolean {
  if (job.trigger_kind !== 'cron') return false;
  if (!job.payload) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(job.payload);
  } catch {
    return false;
  }
  if (!isCronPayload(parsed)) return false;
  scheduleCronJob(db, { name: job.name, cron: parsed.cron, tz: parsed.tz }, from);
  return true;
}
