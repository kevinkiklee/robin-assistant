const ENTITY_EDGES = ['works_on', 'participates_in', 'co_occurs_with'];

export function createRelatedEntitiesTool({ db }) {
  return {
    name: 'related_entities',
    description:
      'Find entities connected to a given entity via graph edges (works_on, co_occurs_with, etc.). Depth 1 or 2.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        edge_types: { type: 'array', items: { type: 'string', enum: ENTITY_EDGES } },
        depth: { type: 'integer', enum: [1, 2], default: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      required: ['id'],
    },
    handler: async (args) => {
      const idRef = args.id.startsWith('entities:') ? args.id : `entities:${args.id}`;
      const edgeTypes = args.edge_types ?? ENTITY_EDGES;
      const limit = args.limit ?? 20;

      const related = [];
      for (const et of edgeTypes) {
        const [rows] = await db
          .query(`SELECT ->${et}->entities.* AS neighbors, ->${et}.* AS edges FROM ${idRef}`)
          .collect();
        const neighbors = rows[0]?.neighbors ?? [];
        const edges = rows[0]?.edges ?? [];
        for (let i = 0; i < neighbors.length; i++) {
          if (related.length >= limit) break;
          const n = neighbors[i];
          const eRow = edges[i];
          related.push({
            entity: { id: String(n.id), name: n.name, type: n.type },
            edge_type: et,
            ...(eRow?.strength != null ? { strength: eRow.strength } : {}),
            distance: 1,
          });
        }
        if (related.length >= limit) break;
      }
      return { related: related.slice(0, limit) };
    },
  };
}
