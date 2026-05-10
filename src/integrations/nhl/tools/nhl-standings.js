import { surql } from 'surrealdb';

export function createNhlStandingsTool({ db }) {
  return {
    name: 'nhl_standings',
    description: 'Returns the most recent NHL standings snapshot.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const [rows] = await db
        .query(
          surql`SELECT id, content, ts, meta FROM events WHERE source = 'nhl' AND meta.kind = 'standings' ORDER BY ts DESC LIMIT 1`,
        )
        .collect();
      const row = rows[0];
      return { standings: row ? { ...row, id: String(row.id) } : null };
    },
  };
}
