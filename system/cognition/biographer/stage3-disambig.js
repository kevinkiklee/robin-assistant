const SYSTEM = `You disambiguate entity mentions. Given a mention and a list of candidate existing entities, pick the candidate that refers to the same thing, or null if none do.

Output JSON only: { "pick": "<candidate id>" } or { "pick": null }.

Be conservative: if uncertain, return null.`;

export async function stage3Disambig(host, { mention, type, candidates }) {
  const candidateLines = candidates
    .map((c) => `- id=${c.id}: name="${c.name}" type=${type} similarity=${c.similarity.toFixed(3)}`)
    .join('\n');
  const userContent = `Mention: "${mention}" (type=${type})

Candidates:
${candidateLines}

Pick the candidate id that refers to the same entity, or null if none. JSON only.`;

  let result;
  try {
    const r = await host.invokeLLM([{ role: 'user', content: userContent }], {
      tier: 'fast',
      json: true,
      system: [{ role: 'system', content: SYSTEM, cache_control: { type: 'ephemeral' } }],
    });
    result = JSON.parse(r.content);
  } catch {
    return { action: 'none' };
  }
  if (!result || typeof result !== 'object') return { action: 'none' };
  const pickedId = result.pick;
  if (!pickedId) return { action: 'none' };
  const validIds = new Set(candidates.map((c) => String(c.id)));
  if (!validIds.has(String(pickedId))) return { action: 'none' };
  return { action: 'resolve', entityId: pickedId };
}
