import { surql } from 'surrealdb';
import { expectedIntervalMs, nextFire, parseCron } from './cron.js';
import { getJob, setNextRunAt } from './db.js';

const CATCHUP_FACTOR = 1.5;

export async function planNextRunAt(db, jobs, now = new Date()) {
  for (const j of jobs) {
    const row = await getJob(db, j.name);
    if (!row || !row.enabled) continue;
    let parsed;
    try {
      parsed = parseCron(j.schedule);
    } catch (e) {
      console.warn(`[jobs] ${j.name}: bad schedule '${j.schedule}': ${e.message}`);
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
  const [rows] = await db
    .query(
      surql`SELECT name FROM runtime_jobs
            WHERE enabled = true AND in_flight = false AND next_run_at <= ${now}
            ORDER BY name`,
    )
    .collect();
  return (rows ?? []).map((r) => ({ name: r.name, kind: 'job' }));
}
