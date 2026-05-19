import { CronExpressionParser } from 'cron-parser';
import type { RobinDb } from '../../brain/memory/db.ts';

export function getNextRunAt(cron: string, from: Date): Date {
  const it = CronExpressionParser.parse(cron, { currentDate: from, tz: 'UTC' });
  return it.next().toDate();
}

export interface CronJobSpec {
  name: string;
  cron: string;
}

export function scheduleCronJob(db: RobinDb, spec: CronJobSpec, from: Date = new Date()): void {
  const next = getNextRunAt(spec.cron, from);
  const nextIso = next.toISOString();

  // Idempotent: only insert if no pending row exists for this name
  const existing = db
    .prepare(`
    SELECT id FROM jobs WHERE name = ? AND state = 'pending'
  `)
    .get(spec.name);

  if (existing) return;

  db.prepare(`
    INSERT INTO jobs (name, trigger_kind, scheduled_at, state)
    VALUES (?, 'cron', ?, 'pending')
  `).run(spec.name, nextIso);
}
