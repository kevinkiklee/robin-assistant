// Format helper for find_entity / get_entity / related_entities results.
// Standardizes: { id, kind, name, summary, edges, events, meta }.
// Caller passes `full: true` to disable trimming.

const DEFAULT_EDGES_LIMIT = 20;
const DEFAULT_EVENTS_LIMIT = 10;

export function formatEntity(raw, { full = false } = {}) {
  const edges = raw?.edges ?? [];
  const events = raw?.events ?? [];
  return {
    id: raw?.id,
    kind: raw?.kind,
    name: raw?.name,
    summary: raw?.summary ?? null,
    edges: full ? edges : edges.slice(0, DEFAULT_EDGES_LIMIT),
    events: full ? events : events.slice(0, DEFAULT_EVENTS_LIMIT),
    meta: {
      total_edges: edges.length,
      total_events: events.length,
      trimmed:
        !full && (edges.length > DEFAULT_EDGES_LIMIT || events.length > DEFAULT_EVENTS_LIMIT),
    },
  };
}
