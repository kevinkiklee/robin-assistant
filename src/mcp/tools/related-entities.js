// related_entities — neighbor lookup over the unified edges table.
//
// Replaces the old `->edge_table->entities` graph traversal syntax (per-table
// edges are gone). Selects from `edges` directly, filtering by `kind` and
// returning the "other" endpoint for each row.

const ENTITY_EDGE_KINDS = ['works_on', 'participates_in', 'occurs_with'];

export function createRelatedEntitiesTool({ db }) {
  return {
    name: 'related_entities',
    description:
      'Find entities connected to a given entity via graph edges (works_on, occurs_with, etc.). Depth 1 or 2.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        edge_types: { type: 'array', items: { type: 'string', enum: ENTITY_EDGE_KINDS } },
        depth: { type: 'integer', enum: [1, 2], default: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      required: ['id'],
    },
    handler: async (args) => {
      const idRef = args.id.startsWith('entities:') ? args.id : `entities:${args.id}`;
      // Accept the legacy alias `co_occurs_with` from older callers.
      const requested = (args.edge_types ?? ENTITY_EDGE_KINDS).map((k) =>
        k === 'co_occurs_with' ? 'occurs_with' : k,
      );
      const limit = args.limit ?? 20;

      const related = [];
      for (const kind of requested) {
        if (related.length >= limit) break;
        // `IF in = $self THEN out ELSE in END` collapses direction so
        // symmetric kinds (occurs_with) return the other endpoint regardless
        // of which side this entity sits on after canonical ordering.
        const sql = `SELECT
            IF in = ${idRef} THEN out ELSE in END AS other,
            weight
          FROM edges
          WHERE kind = '${kind}' AND (in = ${idRef} OR out = ${idRef})
          ORDER BY weight DESC
          LIMIT ${limit}`;
        const [rows] = await db.query(sql).collect();
        const others = rows ?? [];
        if (others.length === 0) continue;
        const [entRows] = await db
          .query('SELECT id, name, type FROM entities WHERE id IN $ids', {
            ids: others.map((r) => r.other),
          })
          .collect();
        const entById = new Map((entRows ?? []).map((e) => [String(e.id), e]));
        for (const r of others) {
          if (related.length >= limit) break;
          const n = entById.get(String(r.other));
          if (!n) continue;
          related.push({
            entity: { id: String(n.id), name: n.name, type: n.type },
            edge_type: kind,
            ...(r.weight != null ? { strength: r.weight } : {}),
            distance: 1,
          });
        }
      }
      return { related: related.slice(0, limit) };
    },
  };
}
