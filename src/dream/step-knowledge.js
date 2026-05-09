import { surql } from 'surrealdb';
import { createKnowledge } from '../memory/knowledge.js';
import { KNOWLEDGE_SYNTHESIS_SYSTEM } from './prompts.js';

const DEFAULT_MIN_SIGNALS = 3;

/**
 * Knowledge synthesis step of the dream pipeline.
 *
 * Finds entities with ≥ `minSignals` un-dreamed mentions and asks the LLM
 * whether to promote a fact about each into the `knowledge` table.
 *
 * Uses a two-step query (collect un-dreamed event ids first, then group
 * mentions by entity) for predictable behaviour across SurrealDB engines —
 * traversal-via-`in.dreamed_at` works inline but the two-step form is more
 * robust against query-planner edge cases on the in-memory engine.
 */
export async function dreamStepKnowledge(
  db,
  host,
  embedder,
  { minSignals = DEFAULT_MIN_SIGNALS } = {},
) {
  const [undreamed] = await db
    .query(surql`SELECT VALUE id FROM events WHERE dreamed_at IS NONE`)
    .collect();
  if (!undreamed || undreamed.length === 0) return { eligible: 0, promoted: 0 };

  const [counts] = await db
    .query(
      surql`SELECT out AS entity_id, count() AS mention_count
            FROM mentions
            WHERE in IN ${undreamed}
            GROUP BY entity_id`,
    )
    .collect();

  const eligible = (counts ?? []).filter((c) => (c.mention_count ?? 0) >= minSignals);
  let promoted = 0;

  for (const c of eligible) {
    const entityId = c.entity_id;
    const [evRows] = await db
      .query(
        surql`SELECT id, content, ts FROM events
              WHERE id IN (SELECT VALUE in FROM mentions WHERE out = ${entityId})
                AND dreamed_at IS NONE
              LIMIT 20`,
      )
      .collect();
    if (!evRows || evRows.length < minSignals) continue;
    const [entRows] = await db.query(surql`SELECT name, type FROM ${entityId}`).collect();
    if (!entRows[0]) continue;
    const ent = entRows[0];

    const userPrompt = `Entity: ${ent.type}/${ent.name}

Recent observations:
${evRows.map((e) => `- ${e.content}`).join('\n')}

Decide whether to promote knowledge.`;

    let result;
    try {
      const r = await host.invokeLLM([{ role: 'user', content: userPrompt }], {
        tier: 'fast',
        json: true,
        system: [
          {
            role: 'system',
            content: KNOWLEDGE_SYNTHESIS_SYSTEM,
            cache_control: { type: 'ephemeral' },
          },
        ],
      });
      result = JSON.parse(r.content);
    } catch {
      continue;
    }

    if (result?.promote && result.knowledge_text) {
      await createKnowledge(db, embedder, {
        content: result.knowledge_text,
        subject_id: entityId,
        confidence: Math.min(1, Math.max(0, result.confidence ?? 0.7)),
        source_events: evRows.map((e) => e.id),
        source_episodes: [],
      });
      promoted++;
    }
  }

  return { eligible: eligible.length, promoted };
}
