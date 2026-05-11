import { BoundQuery } from 'surrealdb';

export function createGithubRecentActivityTool({ db }) {
  return {
    name: 'github_recent_activity',
    description:
      'List recent GitHub activity events captured from the events table. ' +
      'Filters: days (default 7), repo (full name e.g. owner/repo), limit (default 20).',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 90, default: 7 },
        repo: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
      },
    },
    handler: async (args) => {
      const days = args.days ?? 7;
      const limit = Math.min(args.limit ?? 20, 200);
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      const filters = ["source = 'github'", "meta.kind = 'github_activity'", 'ts >= $cutoff'];
      const bindings = { cutoff };

      if (args.repo) {
        filters.push('meta.repo = $repo');
        bindings.repo = args.repo;
      }

      const sql = `SELECT id, meta.external_id AS external_id, content, ts, meta FROM events WHERE ${filters.join(' AND ')} ORDER BY ts DESC LIMIT ${limit}`;
      const [rows] = await db.query(new BoundQuery(sql, bindings)).collect();
      return { events: rows.map((r) => ({ ...r, id: String(r.id) })) };
    },
  };
}
