// get-arc.js — Theme 1b. Returns a single arc with hydrated episode + entity refs.
import { RecordId } from 'surrealdb';
import { formatArc } from '../../format/arc.js';
import { getArc } from '../../../cognition/memory/arcs.js';

export function createGetArcTool({ db }) {
  return {
    name: 'get_arc',
    description: 'Get a single arc by id, with hydrated entity + episode references.',
    inputSchema: {
      type: 'object',
      properties: {
        arc_id: { type: 'string', minLength: 1 },
        full: {
          type: 'boolean',
          default: false,
          description: 'Return untrimmed linked entities + recent events.',
        },
      },
      required: ['arc_id'],
    },
    handler: async ({ arc_id, full = false }) => {
      const id = arc_id.startsWith('arcs:')
        ? new RecordId('arcs', arc_id.slice('arcs:'.length))
        : new RecordId('arcs', arc_id);
      const arc = await getArc(db, id);
      if (!arc) return { error: 'not_found' };
      const linked = (arc.entity_ids ?? []).map(String);
      const events = (arc.meta?.episode_ids ?? []).map(String);
      const raw = {
        id: String(arc.id),
        name: arc.name ?? null,
        kind: 'arc',
        summary: arc.summary ?? null,
        started_at: arc.started_at,
        ended_at: arc.ended_at ?? null,
        linked_entities: linked,
        events,
      };
      const formatted = formatArc(raw, { full });
      // Preserve legacy top-level fields the agent already consumes
      // (entity_ids, episode_ids, status, last_activity_at) alongside the
      // helper's structured output.
      return {
        ...formatted,
        status: arc.status,
        last_activity_at: arc.last_activity_at,
        entity_ids: full ? linked : linked.slice(0, formatted.linked_entities.length),
        episode_ids: full ? events : events.slice(0, formatted.recent_events.length),
      };
    },
  };
}
