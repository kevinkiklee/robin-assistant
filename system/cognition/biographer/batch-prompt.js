// batch-prompt.js — multi-event biographer prompt.
//
// Parallel to prompt.js, but accepts an array of events and asks the LLM to
// emit one structured output per input event keyed by event_id. The catalog
// system block keeps cache_control: ephemeral so the catalog tokens are paid
// once per LLM call (and reused by the provider's prompt cache across
// consecutive drains). See spec §2.

const SYSTEM_PROMPT = `You are Robin's biographer. For each event in events[], extract structured information about the people, places, projects, topics, and things mentioned, plus their relationships.

Output JSON only, with this exact shape:
{
  "events": [
    {
      "event_id": "<copied verbatim from the input>",
      "entities": [{ "name": string, "type": "person" | "place" | "project" | "topic" | "thing" }],
      "edges":    [{ "from": entity-name, "type": "mentions" | "about" | "precedes" | "works_on" | "participates_in" | "co_occurs_with", "to": entity-name }],
      "about":    [entity-name],
      "episode_continues_previous": boolean,
      "episode_summary": string | null,
      "evidence_signals": [{ "memo_id": string, "polarity": "corroborates" | "refutes" }]
    }
  ]
}

Rules:
- Output one object per input event, in the same order, with the same event_id.
- Per-event entities/edges/about are scoped to that event's content only.
- Names that reference the same real-world thing across events should use the SAME spelling so resolution can dedup.
- Prefer names from the existing-entities catalog when applicable.
- episode_continues_previous reflects whether this event continues the active episode for the source; the active episode may close mid-batch if an earlier event in the batch already broke continuity.
- Set episode_summary only when episode_continues_previous=false AND there is an active episode for this source.
- evidence_signals is optional; emit only when the event clearly corroborates/refutes an existing memo.
- Be conservative: extract only entities clearly named in the event content.`;

const MAX_EVENT_CONTENT_CHARS = 2000;

function formatCatalog(catalog) {
  if (catalog.length === 0) return 'Existing entities catalog: (no existing entities yet)';
  const byType = {};
  for (const e of catalog) {
    if (!byType[e.type]) byType[e.type] = [];
    byType[e.type].push(e.name);
  }
  const sections = [];
  for (const [type, names] of Object.entries(byType)) {
    sections.push(`${type}: ${names.join(', ')}`);
  }
  return `Existing entities catalog:\n${sections.join('\n')}`;
}

function formatActiveEpisode(activeEpisode, source) {
  if (!activeEpisode) return `Active episode (source=${source}): (none)`;
  return `Active episode (source=${source}): ${activeEpisode.summary ?? '(no summary yet)'} [${activeEpisode.id}]`;
}

function truncateContent(content) {
  if (typeof content !== 'string') return '';
  if (content.length <= MAX_EVENT_CONTENT_CHARS) return content;
  return content.slice(0, MAX_EVENT_CONTENT_CHARS);
}

export function buildBiographerBatchPrompt({ events, catalog, activeEpisode }) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('buildBiographerBatchPrompt: events[] must be non-empty');
  }
  const source = events[0].source;
  const system = [
    { role: 'system', content: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    { role: 'system', content: formatCatalog(catalog), cache_control: { type: 'ephemeral' } },
  ];
  const lines = events.map((e) => ({
    event_id: String(e.id),
    ts: typeof e.ts === 'string' ? e.ts : new Date(e.ts ?? Date.now()).toISOString(),
    source: e.source,
    content: truncateContent(e.content),
  }));
  const userContent = `${formatActiveEpisode(activeEpisode, source)}

Events:
${JSON.stringify(lines, null, 2)}

Output JSON only.`;
  const messages = [{ role: 'user', content: userContent }];
  return { system, messages };
}
