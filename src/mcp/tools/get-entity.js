import { surql } from 'surrealdb';

const EDGE_TABLES = ['mentions', 'about', 'works_on', 'participates_in', 'co_occurs_with'];

export function createGetEntityTool({ db }) {
  return {
    name: 'get_entity',
    description:
      'Fetch a specific entity by its record id, including mention counts and edge summary.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    handler: async (args) => {
      const idRef = args.id.startsWith('entities:') ? args.id : `entities:${args.id}`;
      const [rows] = await db
        .query(`SELECT id, name, type, created_at, meta FROM ${idRef}`)
        .collect();
      if (!rows || rows.length === 0) {
        throw new Error(`entity not found: ${args.id}`);
      }
      const entity = rows[0];

      const edgeSummary = {};
      for (const tbl of EDGE_TABLES) {
        const [c] = await db
          .query(`SELECT count() AS n FROM ${tbl} WHERE in = ${idRef} OR out = ${idRef} GROUP ALL`)
          .collect();
        edgeSummary[tbl] = c[0]?.n ?? 0;
      }

      const [mentionCount] = await db
        .query(`SELECT count() AS n FROM mentions WHERE out = ${idRef} GROUP ALL`)
        .collect();
      const [lastMention] = await db
        .query(`SELECT in.ts AS ts FROM mentions WHERE out = ${idRef} ORDER BY in.ts DESC LIMIT 1`)
        .collect();

      return {
        entity: {
          id: String(entity.id),
          name: entity.name,
          type: entity.type,
          created_at: entity.created_at,
          meta: entity.meta ?? null,
          mention_count: mentionCount[0]?.n ?? 0,
          last_mentioned_at: lastMention[0]?.ts ?? null,
          edge_summary: edgeSummary,
        },
      };
    },
  };
}
