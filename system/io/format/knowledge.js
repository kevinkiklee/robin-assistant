const DEFAULT_RELATED = 10;
const DEFAULT_EVENTS = 5;

export function formatKnowledge(raw, { full = false } = {}) {
  const related = raw?.related_entities ?? [];
  const events = raw?.events ?? [];
  return {
    header: {
      id: raw?.id,
      title: raw?.title ?? null,
      kind: raw?.kind ?? 'fact',
      created_at: raw?.created_at,
      confidence: raw?.confidence ?? null,
    },
    body: raw?.content ?? raw?.body ?? null,
    related_entities: full ? related : related.slice(0, DEFAULT_RELATED),
    recent_events: full ? events : events.slice(0, DEFAULT_EVENTS),
    meta: {
      total_related: related.length,
      total_events: events.length,
      trimmed: !full && (related.length > DEFAULT_RELATED || events.length > DEFAULT_EVENTS),
    },
  };
}
