// show-step-health.js — Theme 4. Aggregates cadence_telemetry per step.
import { BoundQuery } from 'surrealdb';

export function createShowStepHealthTool({ db }) {
  return {
    name: 'show_step_health',
    description: 'Per-step rollup of cadence_telemetry over a window (default last 7d).',
    inputSchema: {
      type: 'object',
      properties: { since: { type: 'string', format: 'date-time' } },
    },
    handler: async ({ since }) => {
      const cutoff = since ? new Date(since) : new Date(Date.now() - 7 * 86_400_000);
      const [rows] = await db
        .query(
          new BoundQuery(
            `SELECT step, count() AS n,
                    math::sum(IF success THEN 1 ELSE 0 END) AS successes,
                    math::mean(duration_ms) AS avg_duration_ms,
                    math::mean(tokens_in + tokens_out) AS avg_tokens
             FROM cadence_telemetry WHERE ts > $cutoff GROUP BY step`,
            { cutoff },
          ),
        )
        .collect();
      return { since: cutoff, steps: rows ?? [] };
    },
  };
}
