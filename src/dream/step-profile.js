import { surql } from 'surrealdb';
import { getProfile } from '../memory/profile.js';
import { createCandidate, findIdenticalProfileCandidate } from '../rules/candidates.js';
import { PROFILE_INFERENCE_SYSTEM } from './prompts.js';

const DEFAULT_MIN_CONFIDENCE = 0.8;

export async function dreamStepProfile(db, host, { minConfidence = DEFAULT_MIN_CONFIDENCE } = {}) {
  const cutoff = new Date(Date.now() - 30 * 86400_000);
  const [evRows] = await db
    .query(
      surql`SELECT content FROM events
            WHERE ts >= ${cutoff} AND biographed_at IS NOT NONE
            LIMIT 200`,
    )
    .collect();
  if (!evRows || evRows.length === 0) return { proposed: 0 };

  const existing = await getProfile(db);
  const userPrompt = `Existing profile:
${JSON.stringify(existing ?? {})}

Recent activity:
${evRows
  .slice(0, 50)
  .map((e) => `- ${e.content}`)
  .join('\n')}

Identify possible profile updates.`;

  let result;
  try {
    const r = await host.invokeLLM([{ role: 'user', content: userPrompt }], {
      tier: 'fast',
      json: true,
      system: [
        {
          role: 'system',
          content: PROFILE_INFERENCE_SYSTEM,
          cache_control: { type: 'ephemeral' },
        },
      ],
    });
    result = JSON.parse(r.content);
  } catch {
    return { proposed: 0 };
  }

  let proposed = 0;
  for (const c of result?.candidates ?? []) {
    if (!c.field || c.value === undefined) continue;
    if ((c.confidence ?? 0) < minConfidence) continue;
    const fields = { [c.field]: c.value };
    const existingId = await findIdenticalProfileCandidate(db, fields);
    if (existingId) continue;
    await createCandidate(db, {
      content: `${c.field}: ${JSON.stringify(c.value)}`,
      kind: 'profile_update',
      signal_events: [],
      payload: { fields, rationale: c.rationale },
      confidence: c.confidence,
    });
    proposed++;
  }
  return { proposed };
}
