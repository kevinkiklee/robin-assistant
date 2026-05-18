// list-arcs.js — Theme 1b read tool. Returns recent arcs.
import { formatJournal } from '../../format/journal.js';
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
        full: {
          type: 'boolean',
          default: false,
          description: 'Return untrimmed list (default trims to limit).',
        },
      },
    },
    handler: async ({ status, limit = 20, full = false }) => {
      const arcs = await listArcs(db, { status, limit });
      const rows = (arcs ?? []).map((a) => ({
        id: String(a.id),
        name: a.name ?? null,
        summary: a.summary ?? null,
        status: a.status,
        started_at: a.started_at,
        ts: a.last_activity_at ?? a.started_at,
        last_activity_at: a.last_activity_at,
        ended_at: a.ended_at ?? null,
        entity_count: (a.entity_ids ?? []).length,
      }));
      const { items, meta } = formatJournal(rows, { limit, full });
      return { arcs: items, meta };
    },
  };
}
