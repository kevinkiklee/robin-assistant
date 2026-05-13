import { surql } from 'surrealdb';

export function createPhotosRecentTool({ db }) {
  return {
    name: 'photos_recent',
    description:
      "Returns the most recently captured photos from the Photography/Collection sweep. Optional category filter (top-level folder name like 'birds', 'cityscape'). Default limit 20, max 100.",
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        category: { type: 'string' },
      },
    },
    handler: async (args = {}) => {
      const limit = Math.min(100, Math.max(1, args.limit ?? 20));
      const category = (args.category ?? '').toString().trim();
      const [rows] = category
        ? await db
            .query(
              surql`SELECT id, content, ts, meta FROM events
                    WHERE source = 'photos' AND meta.category = ${category}
                    ORDER BY ts DESC LIMIT ${limit}`,
            )
            .collect()
        : await db
            .query(
              surql`SELECT id, content, ts, meta FROM events
                    WHERE source = 'photos'
                    ORDER BY ts DESC LIMIT ${limit}`,
            )
            .collect();
      return { photos: rows.map((r) => ({ ...r, id: String(r.id) })) };
    },
  };
}
