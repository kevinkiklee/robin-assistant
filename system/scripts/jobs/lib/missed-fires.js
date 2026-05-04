// Identifies enabled jobs whose last_run_at is older than 1.5x the expected
// schedule interval — i.e. their OS-scheduler firing was silently dropped
// (laptop paused, launchd glitched, plist reload race, etc.).
//
// The reconciler heartbeat dispatches these via the runner, which re-checks
// catch-up before executing, so a false positive here is harmless.

import { parseCron, expectedIntervalMs } from './cron.js';

export function findMissedFires({ jobs, states, now = new Date(), excludeNames = [] }) {
  const exclude = new Set(excludeNames);
  const missed = [];
  for (const [name, def] of jobs) {
    if (exclude.has(name)) continue;
    if (def.frontmatter.enabled === false) continue;
    const schedule = def.frontmatter.schedule;
    if (!schedule) continue;
    const state = states.get ? states.get(name) : states[name];
    if (!state || !state.last_run_at) continue;
    let cron;
    try {
      cron = parseCron(schedule);
    } catch {
      continue;
    }
    const expected = expectedIntervalMs(cron, now);
    if (!Number.isFinite(expected)) continue;
    const last = new Date(state.last_run_at).getTime();
    if (!Number.isFinite(last)) continue;
    const elapsed = now.getTime() - last;
    if (elapsed > expected * 1.5) {
      missed.push({ name, elapsedMs: elapsed, expectedMs: expected });
    }
  }
  return missed;
}
