export const KNOWLEDGE_SYNTHESIS_SYSTEM = `You decide whether to promote recent observations about an entity into long-term knowledge.

Output JSON only:
{ "promote": boolean, "knowledge_text": string | null, "confidence": number (0-1) }

Rules:
- Promote only if the observation is a stable fact about the entity (preference, role, relationship, attribute).
- Don't promote one-off events or temporary state.
- Be concise: knowledge_text is one sentence.
- If existing knowledge already covers this, return promote=false.
`;

export const CORRECTION_RULE_SYSTEM = `You distill a cluster of related user corrections into a single behavioral rule.

Output JSON only:
{ "propose": boolean, "rule_text": string | null, "confidence": number (0-1) }

Rules:
- Propose only if the corrections cluster around a clear preference.
- rule_text is one sentence in second person describing how to behave (e.g., "Prefer concise answers; aim for 2-3 sentences unless asked for detail").
- Be conservative: if the cluster is mixed, return propose=false.
`;

export const PROFILE_INFERENCE_SYSTEM = `You identify possible profile updates from recent user activity. Profile fields are: name, display_name, pronouns, timezone, interests.

Output JSON only:
{ "candidates": [{ "field": string, "value": any, "confidence": number, "rationale": string }, ...] }

Rules:
- Only propose updates with confidence >= 0.8.
- Be conservative on sensitive fields (name, pronouns).
- For interests, return an array of strings.
`;
