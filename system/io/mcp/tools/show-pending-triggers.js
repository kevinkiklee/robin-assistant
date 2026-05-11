// show-pending-triggers.js — Theme 4.
import { BoundQuery, surql } from 'surrealdb';

export function createShowPendingTriggersTool({ db }) {
  return {
    name: 'show_pending_triggers',
    description: 'List unprocessed dream_triggers (queue depth + ages).',
    inputSchema: {
      type: 'object',
      properties: {
        step: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
    },
    handler: async ({ step, limit = 50 }) => {
      let rows;
      if (step) {
        const [r] = await db
          .query(
            new BoundQuery(
              'SELECT * FROM dream_triggers WHERE processed_at IS NONE AND step = $s ORDER BY requested_at ASC LIMIT $l',
              { s: step, l: limit },
            ),
          )
          .collect();
        rows = r;
      } else {
        const [r] = await db
          .query(
            surql`SELECT * FROM dream_triggers WHERE processed_at IS NONE ORDER BY requested_at ASC LIMIT ${limit}`,
          )
          .collect();
        rows = r;
      }
      return { count: rows?.length ?? 0, pending: rows ?? [] };
    },
  };
}
