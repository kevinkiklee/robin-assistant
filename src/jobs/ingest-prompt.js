// src/jobs/ingest-prompt.js
//
// Edge-kind vocabulary updated to the new EDGE_KIND_REGISTRY names
// (occurs_with replaces co_occurs_with; before replaces precedes).
// The ingest tool also accepts the legacy aliases for backward compatibility,
// but the prompt steers the model toward the new names.
export function buildIngestPrompt(content) {
  return `You are extracting structured memory from a source document.

Document:
"""
${content.slice(0, 200_000)}
"""

Extract entities, relationships, and knowledge claims. Respond with strict JSON only:

{
  "entities": [{"name": "string", "type": "person|place|project|topic|thing", "aliases": ["..."], "confidence": 0.0-1.0}],
  "edges": [{"src_name": "string", "dst_name": "string", "kind": "mentions|about|works_on|participates_in|occurs_with", "meta": {}}],
  "knowledge": [{"content": "string (one fact, one sentence)", "subject_name": "string (an entity name above, optional)", "confidence": 0.0-1.0}]
}

Rules:
- Be conservative — only extract claims directly supported by the text.
- Entity types must be one of: person, place, project, topic, thing.
- Edge kinds must be one of the 5 listed (the 'before' kind is for events-only and is reserved).
- Knowledge claims should be single sentences with subject + predicate.
- If nothing extractable, return empty arrays. Do not invent.
- Output JSON only — no commentary, no markdown fences.`;
}
