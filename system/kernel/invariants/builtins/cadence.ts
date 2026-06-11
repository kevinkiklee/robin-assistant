import { getNextRunAt } from '../../scheduler/cron.ts';

/**
 * Expected interval between runs of a cron expression, in ms; null when unparseable.
 * Note: variable-period expressions (e.g. monthly) return the specific interval
 * between the first two runs after 2026-01-05 UTC, not an average.
 */
export function cadenceMs(cron: string): number | null {
  let a: Date;
  try {
    const anchor = new Date('2026-01-05T00:00:00Z'); // fixed Monday anchor → deterministic
    a = getNextRunAt(cron, anchor, 'UTC');
  } catch {
    return null; // unparseable cron
  }
  const b = getNextRunAt(cron, a, 'UTC');
  return b.getTime() - a.getTime();
}
