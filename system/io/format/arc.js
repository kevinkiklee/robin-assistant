const DEFAULT_LINKED_ENTITIES = 10;
const DEFAULT_RECENT_EVENTS = 10;

export function formatArc(raw, { full = false } = {}) {
  const linked = raw?.linked_entities ?? [];
  const events = raw?.events ?? [];
  return {
    header: {
      id: raw?.id,
      name: raw?.name ?? null,
      kind: raw?.kind ?? 'arc',
      started_at: raw?.started_at,
      ended_at: raw?.ended_at,
      total_entities: linked.length,
      total_events: events.length,
    },
    summary: raw?.summary ?? null,
    linked_entities: full ? linked : linked.slice(0, DEFAULT_LINKED_ENTITIES),
    recent_events: full ? events : events.slice(0, DEFAULT_RECENT_EVENTS),
    meta: {
      trimmed: !full && (linked.length > DEFAULT_LINKED_ENTITIES || events.length > DEFAULT_RECENT_EVENTS),
    },
  };
}
