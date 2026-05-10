import { BoundQuery } from 'surrealdb';

export function createNhlRecentTool({ db }) {
  return {
    name: 'nhl_recent',
    description: 'List recently captured NHL games (schedule events). Filters: team, limit.',
    inputSchema: {
      type: 'object',
      properties: {
        team: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
    },
    handler: async (args) => {
      const filters = ["source = 'nhl'", "meta.kind = 'game'"];
      const bindings = {};
      if (args.team) {
        filters.push('(meta.away = $team OR meta.home = $team)');
        bindings.team = args.team;
      }
      const limit = Math.min(args.limit ?? 50, 200);
      const sql = `SELECT id, content, ts, meta FROM events WHERE ${filters.join(' AND ')} ORDER BY ts DESC LIMIT ${limit}`;
      const [rows] = await db.query(new BoundQuery(sql, bindings)).collect();
      return { games: rows.map((r) => ({ ...r, id: String(r.id) })) };
    },
  };
}
