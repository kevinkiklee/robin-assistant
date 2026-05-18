import { surql } from 'surrealdb';
import { getProfile } from '../memory/persona.js';
import { createCandidate, findIdenticalProfileCandidate } from './candidates.js';
import { mergeTrust } from '../discretion/wrap-untrusted.js';
import { PROFILE_INFERENCE_SYSTEM } from './prompts.js';

const DEFAULT_MIN_CONFIDENCE = 0.8;

export async function dreamStepProfile(db, host, { minConfidence = DEFAULT_MIN_CONFIDENCE } = {}) {
  const cutoff = new Date(Date.now() - 30 * 86400_000);
  const [evRows] = await db
    .query(
      surql`SELECT content, derived_from_trust FROM events
            WHERE ts >= ${cutoff} AND biographed_at IS NOT NONE
            LIMIT 200`,
    )
    .collect();
  if (!evRows || evRows.length === 0) return { proposed: 0 };

  const sourceTrust = mergeTrust((evRows ?? []).map((r) => r.derived_from_trust ?? 'trusted'));

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
  let tokens_in = 0;
  let tokens_out = 0;
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
    tokens_in = r?.usage?.input_tokens ?? 0;
    tokens_out = r?.usage?.output_tokens ?? 0;
    result = JSON.parse(r.content);
  } catch {
    return { proposed: 0, tokens_in, tokens_out };
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
      derived_from_trust: sourceTrust,
    });
    proposed++;
  }
  return { proposed, tokens_in, tokens_out };
}
