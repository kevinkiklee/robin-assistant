import { BoundQuery } from 'surrealdb';

export function createYouTubeListLikedTool({ db }) {
  return {
    name: 'youtube_list_liked',
    description: 'List captured YouTube liked videos from the events table.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
    },
    handler: async (args) => {
      const limit = Math.min(args.limit ?? 50, 200);
      const sql = `SELECT id, content, ts, meta FROM events WHERE source = 'youtube' AND meta.kind = 'liked_video' ORDER BY ts DESC LIMIT ${limit}`;
      const [rows] = await db.query(new BoundQuery(sql, {})).collect();
      return { liked: rows.map((r) => ({ ...r, id: String(r.id) })) };
    },
  };
}
