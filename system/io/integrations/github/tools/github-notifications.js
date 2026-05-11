import { BoundQuery } from 'surrealdb';

export function createGithubNotificationsTool({ db }) {
  return {
    name: 'github_notifications',
    description:
      'List captured GitHub notifications from the events table. ' +
      'Filters: unread (boolean, omit for all), limit (default 30).',
    inputSchema: {
      type: 'object',
      properties: {
        unread: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 30 },
      },
    },
    handler: async (args) => {
      const limit = Math.min(args.limit ?? 30, 200);
      const filters = ["source = 'github'", "meta.kind = 'github_notif'"];
      const bindings = {};

      if (typeof args.unread === 'boolean') {
        filters.push('meta.unread = $unread');
        bindings.unread = args.unread;
      }

      const sql = `SELECT id, meta.external_id AS external_id, content, ts, meta FROM events WHERE ${filters.join(' AND ')} ORDER BY ts DESC LIMIT ${limit}`;
      const [rows] = await db.query(new BoundQuery(sql, bindings)).collect();
      return { notifications: rows.map((r) => ({ ...r, id: String(r.id) })) };
    },
  };
}
