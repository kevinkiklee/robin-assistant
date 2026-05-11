const SYSTEM_PROMPT = `You are Robin's biographer. For each event, extract structured information about the people, places, projects, topics, and things mentioned, plus their relationships.

Output JSON only, with this exact shape:
{
  "entities": [{ "name": string, "type": "person" | "place" | "project" | "topic" | "thing" }, ...],
  "edges": [{ "from": entity-name, "type": "mentions" | "about" | "precedes" | "works_on" | "participates_in" | "co_occurs_with", "to": entity-name }, ...],
  "about": [entity-name, ...],
  "episode_continues_previous": boolean,
  "episode_summary": string | null
}

Rules:
- Only use names that appear in entities[] for edges[] and about[].
- Prefer names from the existing-entities catalog when applicable.
- Set episode_continues_previous=true if the event is a clear continuation of the active episode (same topic + temporal proximity); false otherwise.
- Set episode_summary only when ending an episode (and only if episode_continues_previous=false AND there's an active episode).
- Be conservative: extract only entities clearly named in the event content.`;

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
