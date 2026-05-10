import { BoundQuery } from 'surrealdb';

const KINDS = ['recovery', 'sleep', 'workout', 'cycle'];

export function createWhoopRecentTool({ db }) {
  return {
    name: 'whoop_recent',
    description: 'Recent Whoop records (recovery, sleep, workout, cycle) from the events table.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: KINDS },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
    },
    handler: async (args) => {
      const limit = Math.min(args.limit ?? 20, 100);
      const filters = ["source = 'whoop'"];
      const bindings = {};
      if (args.kind) {
        if (!KINDS.includes(args.kind)) throw new Error(`unknown kind: ${args.kind}`);
        filters.push('meta.kind = $kind');
        bindings.kind = args.kind;
      }
      const sql = `SELECT id, content, ts, meta FROM events WHERE ${filters.join(' AND ')} ORDER BY ts DESC LIMIT ${limit}`;
      const [rows] = await db.query(new BoundQuery(sql, bindings)).collect();
      return { records: rows.map((r) => ({ ...r, id: String(r.id) })) };
    },
  };
}
