import { getNextRunAt } from '../../scheduler/cron.ts';

/** Expected interval between runs of a cron expression, in ms; null when unparseable. */
export function cadenceMs(cron: string): number | null {
  try {
    const anchor = new Date('2026-01-05T00:00:00Z'); // fixed Monday anchor → deterministic, avoids DST edges
    const a = getNextRunAt(cron, anchor, 'UTC');
    const b = getNextRunAt(cron, a, 'UTC');
    return b.getTime() - a.getTime();
  } catch {
    return null;
  }
}
