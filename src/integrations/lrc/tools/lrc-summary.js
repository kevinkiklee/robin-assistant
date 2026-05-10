import { BoundQuery } from 'surrealdb';

export function createLrcSummaryTool({ db }) {
  return {
    name: 'lrc_summary',
    description: 'Latest Lightroom Classic catalog summary.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const sql = `SELECT id, content, ts, meta FROM events WHERE source = 'lrc' ORDER BY ts DESC LIMIT 1`;
      const [rows] = await db.query(new BoundQuery(sql, {})).collect();
      return { summary: rows[0] ? { ...rows[0], id: String(rows[0].id) } : null };
    },
  };
}
