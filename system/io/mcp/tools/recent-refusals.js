// recent-refusals.js — Theme 4.
import { BoundQuery } from 'surrealdb';

export function createRecentRefusalsTool({ db }) {
  return {
    name: 'recent_refusals',
    description: 'List recent discretion refusals (inbound / outbound) with reason and tool.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['inbound', 'outbound'] },
        since: { type: 'string', format: 'date-time' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
    },
    handler: async ({ direction, since, limit = 50 }) => {
      const filters = [];
      const bindings = { limit };
      if (direction) {
        filters.push('direction = $direction');
        bindings.direction = direction;
      }
      if (since) {
        filters.push('created_at > $since');
        bindings.since = new Date(since);
      }
      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      const [rows] = await db
        .query(
          new BoundQuery(
            `SELECT direction, reason, tool, content, created_at, meta FROM refusals ${where} ORDER BY created_at DESC LIMIT $limit`,
            bindings,
          ),
        )
        .collect();
      return { refusals: rows ?? [] };
    },
  };
}
