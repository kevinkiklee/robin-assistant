// list-arcs.js — Theme 1b read tool. Returns recent arcs.
import { listArcs } from '../../../cognition/memory/arcs.js';

export function createListArcsTool({ db }) {
  return {
    name: 'list_arcs',
    description: 'List multi-episode arcs of activity, ordered by recency.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'paused', 'closed'] },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
    },
    handler: async ({ status, limit = 20 }) => {
      const arcs = await listArcs(db, { status, limit });
      return {
        arcs: (arcs ?? []).map((a) => ({
          id: String(a.id),
          name: a.name ?? null,
          summary: a.summary ?? null,
          status: a.status,
          started_at: a.started_at,
          last_activity_at: a.last_activity_at,
          ended_at: a.ended_at ?? null,
          entity_count: (a.entity_ids ?? []).length,
        })),
      };
    },
  };
}
