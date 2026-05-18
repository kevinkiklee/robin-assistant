// batch-prompt.js — multi-event biographer prompt.
//
// Parallel to prompt.js, but accepts an array of events and asks the LLM to
// emit one structured output per input event keyed by event_id. The catalog
// system block keeps cache_control: ephemeral so the catalog tokens are paid
// once per LLM call (and reused by the provider's prompt cache across
// consecutive drains). See spec §2.

const SYSTEM_PROMPT = `You are Robin's biographer. For each event in events[], extract structured information about the people, places, projects, topics, and things mentioned, plus their relationships.

Output raw JSON only — NO markdown code fences (no \`\`\`json), NO prose before or after. The shape must be exactly:
{
  "events": [
    {
      "event_id": "<copied verbatim from the input>",
      "entities": [{ "name": string, "type": "person" | "place" | "project" | "topic" | "thing", "source_event_ids": [string] }],
      "edges":    [{ "from": entity-name, "type": "mentions" | "about" | "precedes" | "works_on" | "participates_in" | "co_occurs_with", "to": entity-name, "source_event_ids": [string] }],
      "about":    [entity-name],
      "episode_continues_previous": boolean,
      "episode_summary": string | null
    }
  ]
}

source_event_ids schema for entities and edges:
  "source_event_ids": {
    "type": "array",
    "items": { "type": "string" },
    "description": "IDs of input events that this extraction is derived from. Cite only events present in the input."
  }

Vocabulary is closed — do NOT invent new entity types or edge types.
- Entity types: person, place, project, topic, thing. Map businesses/services/organizations/products to "thing". Map abstract concepts/themes to "topic".
- Edge types: mentions, about, precedes, works_on, participates_in, co_occurs_with. Map "uses"/"depends on"/"created by"/"located in" to either "mentions" (weak) or omit.

Rules:
- Output one object per input event, in the same order, with the same event_id.
- For every per-event object: entities[], edges[], about[] must each be an array (use [] if nothing detected, never null). episode_continues_previous must be a boolean (never null/string).
- Only use names that appear in that event's entities[] for its edges[] and about[]. Edge endpoints not in entities[] will be dropped.
- Per-event entities/edges/about are scoped to that event's content only.
- Names that reference the same real-world thing across events should use the SAME spelling so resolution can dedup.
- Prefer names from the existing-entities catalog when applicable (case-sensitive match).
- episode_continues_previous reflects whether this event continues the active episode for the source; the active episode may close mid-batch if an earlier event in the batch already broke continuity.
- Set episode_summary only when episode_continues_previous=false AND there is an active episode for this source.
- Be conservative: extract only entities clearly named in the event content.
- For every extracted entity and edge, include the source_event_ids field listing which input events justify the extraction.`;

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
  // Slice by code points, not UTF-16 code units. `String.slice` splits surrogate
  // pairs (emoji, non-BMP chars) mid-pair, producing invalid UTF-16 the LLM
  // adapter then has to re-encode. Spread into code points first.
  return [...content].slice(0, MAX_EVENT_CONTENT_CHARS).join('');
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
