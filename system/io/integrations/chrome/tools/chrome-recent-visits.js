import { BoundQuery } from 'surrealdb';

export function createChromeRecentVisitsTool({ db }) {
  return {
    name: 'chrome_recent_visits',
    description: 'Recent Chrome browsing visits captured from the local History snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
      },
    },
    handler: async (args) => {
      const limit = Math.min(args.limit ?? 20, 200);
      const sql = `SELECT id, content, ts, meta FROM events WHERE source = 'chrome' AND meta.kind = 'visit' ORDER BY ts DESC LIMIT ${limit}`;
      const [rows] = await db.query(new BoundQuery(sql, {})).collect();
      return { visits: rows.map((r) => ({ ...r, id: String(r.id) })) };
    },
  };
}
