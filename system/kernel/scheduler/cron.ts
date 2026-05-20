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

export function scheduleCronJob(db: RobinDb, spec: CronJobSpec, from: Date = new Date()): void {
  const next = getNextRunAt(spec.cron, from, spec.tz);
  const nextIso = next.toISOString();

  // Idempotent: at most one pending row per name. But if the existing pending row's
  // scheduled_at doesn't match the recomputed next-run (e.g. the user changed cron
  // expression, added a `tz:`, or the prior schedule was computed under a stale TZ
  // default), refresh it. Without this update, a TZ-config change would not take effect
  // until the existing fire either ran or aged out manually.
  const existing = db
    .prepare(`SELECT id, scheduled_at FROM jobs WHERE name = ? AND state = 'pending'`)
    .get(spec.name) as { id: number; scheduled_at: string } | undefined;

  if (existing) {
    if (existing.scheduled_at !== nextIso) {
      db.prepare(`UPDATE jobs SET scheduled_at = ? WHERE id = ?`).run(nextIso, existing.id);
    }
    return;
  }

  db.prepare(`
    INSERT INTO jobs (name, trigger_kind, scheduled_at, state)
    VALUES (?, 'cron', ?, 'pending')
  `).run(spec.name, nextIso);
}
