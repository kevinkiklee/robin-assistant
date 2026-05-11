import { BoundQuery } from 'surrealdb';

export function createEbirdRecentTool({ db }) {
  return {
    name: 'ebird_recent',
    description:
      'List recently captured eBird observations. Filters: days (lookback window), location_id, limit.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 30, default: 7 },
        location_id: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
    },
    handler: async (args) => {
      const filters = ["source = 'ebird'"];
      const bindings = {};
      if (args.days) {
        const since = new Date(Date.now() - args.days * 86_400_000);
        filters.push('ts >= $since');
        bindings.since = since;
      }
      if (args.location_id) {
        filters.push('meta.location_id = $loc');
        bindings.loc = args.location_id;
      }
      const limit = Math.min(args.limit ?? 50, 200);
      const sql = `SELECT id, content, ts, meta FROM events WHERE ${filters.join(' AND ')} ORDER BY ts DESC LIMIT ${limit}`;
      const [rows] = await db.query(new BoundQuery(sql, bindings)).collect();
      return { observations: rows.map((r) => ({ ...r, id: String(r.id) })) };
    },
  };
}
