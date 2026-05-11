import { BoundQuery } from 'surrealdb';

export function createLetterboxdRecentTool({ db }) {
  return {
    name: 'letterboxd_recent',
    description: 'Recent Letterboxd diary entries captured from CSV exports.',
    inputSchema: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          minimum: 1,
          default: 30,
          description: 'How many days back to look.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          default: 20,
          description: 'Maximum number of entries to return.',
        },
        min_rating: {
          type: 'number',
          minimum: 0.5,
          maximum: 5,
          description: 'Only return entries with at least this rating (optional).',
        },
      },
    },
    handler: async (args) => {
      const days = args.days ?? 30;
      const limit = Math.min(args.limit ?? 20, 200);
      const minRating = args.min_rating ?? null;

      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

      let sql;
      if (minRating !== null) {
        sql = `SELECT id, content, ts, meta FROM events WHERE source = 'letterboxd' AND meta.kind = 'letterboxd_diary' AND ts >= type::datetime('${since}') AND meta.rating >= ${minRating} ORDER BY ts DESC LIMIT ${limit}`;
      } else {
        sql = `SELECT id, content, ts, meta FROM events WHERE source = 'letterboxd' AND meta.kind = 'letterboxd_diary' AND ts >= type::datetime('${since}') ORDER BY ts DESC LIMIT ${limit}`;
      }

      const [rows] = await db.query(new BoundQuery(sql, {})).collect();
      return { entries: rows.map((r) => ({ ...r, id: String(r.id) })) };
    },
  };
}
