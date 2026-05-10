import { BoundQuery } from 'surrealdb';

export function createChromeTopDomainsTool({ db }) {
  return {
    name: 'chrome_top_domains',
    description: 'Daily top-domain aggregations derived from Chrome history.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 30, default: 7 },
      },
    },
    handler: async (args) => {
      const days = Math.min(args.days ?? 7, 30);
      const sql = `SELECT id, content, ts, meta FROM events WHERE source = 'chrome' AND meta.kind = 'top_domains' ORDER BY ts DESC LIMIT ${days}`;
      const [rows] = await db.query(new BoundQuery(sql, {})).collect();
      return { aggregations: rows.map((r) => ({ ...r, id: String(r.id) })) };
    },
  };
}
