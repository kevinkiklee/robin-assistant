// scheduler.no_stuck_in_flight
//
// Catches jobs that wedge during daemon uptime. Daemon boot clears stuck
// in_flight flags, but a long-running job that hangs mid-execution stays
// flagged until restart. This invariant surfaces such jobs.

import { surql } from 'surrealdb';

const STUCK_THRESHOLD_MS = 30 * 60 * 1000;

export default {
  name: 'scheduler.no_stuck_in_flight',
  level: 'warn',
  surface: 'scheduler',
  phase: 'runtime',
  description: 'No scheduler jobs have been in_flight=true for more than 30 minutes.',

  remediation: [
    'inspect named job: `SELECT * FROM runtime_jobs WHERE name = "<job>";`',
    'manual unstick: `UPDATE runtime_jobs SET in_flight = false WHERE name = "<job>";`',
    'last resort — restart daemon (`kill <pid>`); boot clears all stuck flags',
  ],

  runWhen: {
    boot: { enabled: false },
    heartbeat: { enabled: true, cooldownMs: 15 * 60 * 1000 },
    doctor: { enabled: true },
    postInstall: { enabled: false },
  },

  async check(ctx) {
    if (!ctx?.db) return { ok: false, error: 'no_db_handle' };
    try {
      const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS);
      const [rows] = await ctx.db
        .query(
          surql`SELECT name, started_at FROM runtime_jobs WHERE in_flight = true AND started_at < ${cutoff};`,
        )
        .collect();
      const stuck = Array.isArray(rows) ? rows : [];
      if (stuck.length > 0) {
        return {
          ok: false,
          error: 'stuck_jobs',
          evidence: { names: stuck.map((r) => r.name), count: stuck.length },
        };
      }
      return { ok: true, evidence: { count: 0 } };
    } catch (e) {
      return { ok: false, error: `query_failed:${e.message}` };
    }
  },

  // No automatic repair — boot clears flags on next daemon restart; surfacing
  // the names here lets the user decide whether to kill the daemon now.

  explain(lastResult) {
    const lines = [
      '### `scheduler.no_stuck_in_flight`',
      '',
      '**Symptom.** A scheduled job stops producing output but the daemon is still up. Subsequent ticks skip it because `in_flight=true`.',
      '',
      "**Cause.** A job hung mid-execution (LLM call timeout, file lock, etc.) but the wrapper that clears `in_flight` on exit didn't run.",
      '',
      '**Fix.** Boot-time logic in the scheduler clears stuck flags. To resume the job without restarting the whole daemon, identify the row in `runtime_jobs` and manually set `in_flight=false`. To restart the daemon: kill the pid; launchd respawns.',
    ];
    if (lastResult?.evidence?.names?.length) {
      lines.push('', `**Stuck jobs:** ${lastResult.evidence.names.join(', ')}`);
    }
    return lines.join('\n');
  },
};
