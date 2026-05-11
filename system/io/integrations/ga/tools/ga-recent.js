import { BoundQuery } from 'surrealdb';

export function createGaRecentTool({ db }) {
  return {
    name: 'ga_recent',
    description: 'Recent GA4 daily metrics from captured events.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 90, default: 7 },
      },
    },
    handler: async (args) => {
      const days = Math.min(args?.days ?? 7, 90);
      const sql = `SELECT id, content, ts, meta FROM events WHERE source = 'ga' ORDER BY ts DESC LIMIT ${days * 5}`;
      const [rows] = await db.query(new BoundQuery(sql, {})).collect();
      return { metrics: rows.slice(0, days).map((r) => ({ ...r, id: String(r.id) })) };
    },
  };
}
