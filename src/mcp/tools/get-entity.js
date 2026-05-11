// get_entity — fetch a single entity with edge summary.
//
// Redesigned for the unified `edges` table. The per-relation edge tables are
// gone; counts are computed per-kind by grouping on the `edges.kind` field.
// `co_occurs_with` renamed to `occurs_with` in the registry.

const ENTITY_EDGE_KINDS = ['mentions', 'about', 'works_on', 'participates_in', 'occurs_with'];

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

      // One grouped query covers all edge kinds. `from = entity OR to = entity`
      // captures both directions; the registry's symmetric kinds canonicalize
      // endpoint order so there are no double-counted rows.
      const [summary] = await db
        .query(
          `SELECT kind, count() AS n FROM edges
           WHERE from = ${idRef} OR out = ${idRef}
           GROUP BY kind`,
        )
        .collect();
      const edgeSummary = Object.fromEntries(ENTITY_EDGE_KINDS.map((k) => [k, 0]));
      for (const row of summary ?? []) {
        if (row.kind in edgeSummary) edgeSummary[row.kind] = row.n ?? 0;
        else edgeSummary[row.kind] = row.n ?? 0;
      }

      const [mentionCount] = await db
        .query(
          `SELECT count() AS n FROM edges
           WHERE kind = 'mentions' AND out = ${idRef} GROUP ALL`,
        )
        .collect();

      // Last mention: pull the most recent inbound mentions edge, then read
      // the source event's timestamp. Field-path traversal `from.ts` works on
      // SurrealDB v3 across `record<>` fields.
      const [lastMention] = await db
        .query(
          `SELECT in.ts AS ts FROM edges
           WHERE kind = 'mentions' AND out = ${idRef}
           ORDER BY in.ts DESC LIMIT 1`,
        )
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
