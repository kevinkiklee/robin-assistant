// step-knowledge.js — dream-pipeline knowledge promotion.
//
// Rewritten for the new schema:
//   - Mention counts now come from the unified `edges` table
//     (WHERE kind = 'mentions') instead of the per-relation `mentions` table.
//   - New knowledge memos are written through `store.note('knowledge', …)`;
//     `lineage` is passed in the spec shape `[{id, kind: 'event'}]` so
//     `store.note` emits `derived_from` edges to each source event.
//   - When the LLM marks a prior knowledge memo as superseded by the new
//     promotion, we call `store.supersede(oldId, newId)` so `fn::freshness`
//     returns 0 for the old memo thereafter.

import { surql } from 'surrealdb';
import { toRecordRef } from '../../data/db/record-ref.js';
import * as store from '../memory/store.js';
import { KNOWLEDGE_SYNTHESIS_SYSTEM } from './prompts.js';

const DEFAULT_MIN_SIGNALS = 3;

export async function dreamStepKnowledge(
  db,
  host,
  embedder,
  { minSignals = DEFAULT_MIN_SIGNALS } = {},
) {
  const [undreamed] = await db
    .query(surql`SELECT VALUE id FROM events WHERE dreamed_at IS NONE`)
    .collect();
  if (!undreamed || undreamed.length === 0) {
    return { eligible: 0, promoted: 0, superseded: 0 };
  }

  // Count un-dreamed mentions per entity via the unified edges table.
  const [counts] = await db
    .query(
      surql`SELECT out AS entity_id, count() AS mention_count
            FROM edges
            WHERE kind = 'mentions'
              AND in IN ${undreamed}
            GROUP BY entity_id`,
    )
    .collect();

  const eligible = (counts ?? []).filter((c) => (c.mention_count ?? 0) >= minSignals);
  let promoted = 0;
  let superseded = 0;
  let tokens_in = 0;
  let tokens_out = 0;

  for (const c of eligible) {
    const entityId = toRecordRef(c.entity_id);
    // Pull recent un-dreamed events that mention this entity.
    const [evRows] = await db
      .query(
        surql`SELECT id, content, ts FROM events
              WHERE id IN (SELECT VALUE in FROM edges
                           WHERE kind = 'mentions' AND out = ${entityId})
                AND dreamed_at IS NONE
              LIMIT 20`,
      )
      .collect();
    if (!evRows || evRows.length < minSignals) continue;
    const [entRows] = await db.query(surql`SELECT name, type FROM ${entityId}`).collect();
    if (!entRows[0]) continue;
    const ent = entRows[0];

    // Show the LLM any existing knowledge memos about this entity so it can
    // flag which ones (if any) the new fact supersedes.
    // derived_at must appear in the projection for ORDER BY to bind it in
    // SurrealDB v3's parser.
    const [existingMemos] = await db
      .query(
        surql`SELECT id, content, confidence, derived_at FROM memos
              WHERE kind = 'knowledge'
                AND id IN (SELECT VALUE in FROM edges
                           WHERE kind = 'about' AND out = ${entityId})
              ORDER BY derived_at DESC LIMIT 10`,
      )
      .collect();
    const existingList = (existingMemos ?? []).map(
      (m, i) => `[${i}] (${(m.confidence ?? 0).toFixed(2)}) ${m.content}`,
    );

    const userPrompt = `Entity: ${ent.type}/${ent.name}

Recent observations:
${evRows.map((e) => `- ${e.content}`).join('\n')}

${existingList.length > 0 ? `Existing knowledge about this entity:\n${existingList.join('\n')}\n` : ''}
Decide whether to promote knowledge.
If the new fact contradicts or refines any "Existing knowledge" entry with lower confidence than the new one, also return its index in "supersedes_indices".

Respond JSON only:
{ "promote": boolean, "knowledge_text": string | null, "confidence": number, "supersedes_indices": number[] }`;

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
      tokens_in += r?.usage?.input_tokens ?? 0;
      tokens_out += r?.usage?.output_tokens ?? 0;
      result = JSON.parse(r.content);
    } catch {
      continue;
    }

    if (result?.promote && result.knowledge_text) {
      const newConfidence = Math.min(1, Math.max(0, result.confidence ?? 0.7));
      const lineage = evRows.map((e) => ({ id: e.id, kind: 'event' }));
      const created = await store.note(db, embedder, 'knowledge', {
        content: result.knowledge_text,
        confidence: newConfidence,
        derived_by: 'dream',
        subjects: [entityId],
        lineage,
      });
      promoted++;

      // Supersede any contradicted prior memos whose confidence is below
      // the new one. Index validity and confidence guard prevent the LLM
      // from collapsing unrelated facts.
      const idxs = Array.isArray(result.supersedes_indices) ? result.supersedes_indices : [];
      for (const idx of idxs) {
        const prior = existingMemos?.[idx];
        if (!prior) continue;
        if ((prior.confidence ?? 0) >= newConfidence) continue;
        if (String(prior.id) === String(created.id)) continue;
        await store.supersede(db, prior.id, created.id);
        superseded++;
      }
    }
  }

  return { eligible: eligible.length, promoted, superseded, tokens_in, tokens_out };
}
