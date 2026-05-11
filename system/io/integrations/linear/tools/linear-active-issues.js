import { BoundQuery } from 'surrealdb';

export function createLinearActiveIssuesTool({ db }) {
  return {
    name: 'linear_active_issues',
    description:
      'List captured active Linear issues from the events table. Filters: team, assignee, limit.',
    inputSchema: {
      type: 'object',
      properties: {
        team: { type: 'string' },
        assignee: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
    },
    handler: async (args) => {
      const filters = ["source = 'linear'"];
      const bindings = {};
      if (args.team) {
        filters.push('meta.team = $team');
        bindings.team = args.team;
      }
      if (args.assignee) {
        filters.push('meta.assignee = $assignee');
        bindings.assignee = args.assignee;
      }
      const limit = Math.min(args.limit ?? 50, 200);
      const sql = `SELECT id, content, ts, meta FROM events WHERE ${filters.join(' AND ')} ORDER BY ts DESC LIMIT ${limit}`;
      const [rows] = await db.query(new BoundQuery(sql, bindings)).collect();
      return { issues: rows.map((r) => ({ ...r, id: String(r.id) })) };
    },
  };
}
