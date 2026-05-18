const SYSTEM_PROMPT = `You are Robin's biographer. For each event, extract structured information about the people, places, projects, topics, and things mentioned, plus their relationships.

Output raw JSON only — NO markdown code fences (no \`\`\`json), NO prose before or after. The shape must be exactly:
{
  "entities": [{ "name": string, "type": "person" | "place" | "project" | "topic" | "thing", "source_event_ids": [string] }, ...],
  "edges": [{ "from": entity-name, "type": "mentions" | "about" | "precedes" | "works_on" | "participates_in" | "co_occurs_with", "to": entity-name, "source_event_ids": [string] }, ...],
  "about": [entity-name, ...],
  "episode_continues_previous": boolean,
  "episode_summary": string | null
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
- entities[] must always be an array. Use [] if nothing is detected. Never null.
- edges[] must always be an array. Use [] if no relationships are detected. Never null.
- about[] must always be an array. Use [] if there is no clear subject.
- episode_continues_previous must be a boolean (true/false). Never null or a string.
- Only use names that appear in entities[] for edges[] and about[]. An edge endpoint not in entities[] will be dropped.
- Prefer names from the existing-entities catalog when applicable (case-sensitive match).
- Set episode_continues_previous=true if the event is a clear continuation of the active episode (same topic + temporal proximity); false otherwise.
- Set episode_summary only when ending an episode (and only if episode_continues_previous=false AND there's an active episode).
- Be conservative: extract only entities clearly named in the event content.
- For every extracted entity and edge, include the source_event_ids field listing which input events justify the extraction.`;

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

function formatActiveEpisode(activeEpisode) {
  if (!activeEpisode) return '';
  return `\nActive episode: ${activeEpisode.summary ?? '(no summary yet)'} [${activeEpisode.id}]`;
}

export function buildBiographerPrompt({ event, catalog, activeEpisode }) {
  const system = [
    { role: 'system', content: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    { role: 'system', content: formatCatalog(catalog), cache_control: { type: 'ephemeral' } },
  ];
  const userContent = `Event:
- id: ${event.id}
- source: ${event.source}
- ts: ${event.ts}
- content: ${event.content}${formatActiveEpisode(activeEpisode)}

Output JSON only.`;
  const messages = [{ role: 'user', content: userContent }];
  return { system, messages };
}
