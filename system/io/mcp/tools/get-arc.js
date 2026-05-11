// get-arc.js — Theme 1b. Returns a single arc with hydrated episode + entity refs.
import { RecordId } from 'surrealdb';
import { getArc } from '../../../cognition/memory/arcs.js';

export function createGetArcTool({ db }) {
  return {
    name: 'get_arc',
    description: 'Get a single arc by id, with hydrated entity + episode references.',
    inputSchema: {
      type: 'object',
      properties: { arc_id: { type: 'string', minLength: 1 } },
      required: ['arc_id'],
    },
    handler: async ({ arc_id }) => {
      const id = arc_id.startsWith('arcs:')
        ? new RecordId('arcs', arc_id.slice('arcs:'.length))
        : new RecordId('arcs', arc_id);
      const arc = await getArc(db, id);
      if (!arc) return { error: 'not_found' };
      return {
        id: String(arc.id),
        name: arc.name ?? null,
        summary: arc.summary ?? null,
        status: arc.status,
        started_at: arc.started_at,
        last_activity_at: arc.last_activity_at,
        ended_at: arc.ended_at ?? null,
        entity_ids: (arc.entity_ids ?? []).map(String),
        episode_ids: (arc.meta?.episode_ids ?? []).map(String),
      };
    },
  };
}
