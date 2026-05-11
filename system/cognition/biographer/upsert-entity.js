// upsert-entity.js — the 3-stage entity-resolution cascade used by store.upsertEntity.
//
// Replaces the former `cognition/cascade.js` (deleted in the redesign).
// `store.upsertEntity` imports `upsertEntityCascade` from here.
//
// Stages:
//   1. Exact name_lower + type match (composite index entities_name_lower).
//   2. HNSW embedding similarity over `embeddings_<profile>_entities`
//      (per-profile surface; the entities table no longer carries `embedding`).
//   3. LLM disambiguation over candidates whose similarity falls in the
//      ambiguous band [lowThreshold, highThreshold). Requires `input.host`.
//
// Returns `{ id, created, stage, embedding_source }` so `store.upsertEntity`
// can decide whether to write the entities embedding row.

import { stage1Resolve } from './stage1-exact.js';
import { stage2Resolve } from './stage2-embedding.js';
import { stage3Disambig } from './stage3-disambig.js';

const DEFAULT_HIGH = 0.92;
const DEFAULT_LOW = 0.8;

export async function upsertEntityCascade(db, embedder, input) {
  const { name, type, scope = 'global', tags = [], meta, host, config = {} } = input;
  if (!name) throw new Error('upsertEntityCascade: name required');
  if (!type) throw new Error('upsertEntityCascade: type required');

  const highThreshold = config.stage2_high_threshold ?? DEFAULT_HIGH;
  const lowThreshold = config.stage2_low_threshold ?? DEFAULT_LOW;

  // Stage 1 — exact (no embedding needed).
  const s1 = await stage1Resolve(db, { name, type });
  if (s1) {
    return { id: s1, created: false, stage: 1, embedding_source: null };
  }

  // Stage 2 — embedding similarity. May fail under the new schema until
  // stage2-embedding.js is updated to query embeddings_<profile>_entities;
  // wrap in try so a broken stage2 falls through to creation rather than
  // crashing the whole upsert pipeline.
  let s2;
  if (embedder && typeof embedder.embed === 'function') {
    try {
      s2 = await stage2Resolve(db, embedder, {
        name,
        type,
        highThreshold,
        lowThreshold,
      });
    } catch (e) {
      // Stage 2 is best-effort during the schema-redesign transition.
      s2 = { action: 'none', error: String(e?.message ?? e) };
    }
  } else {
    s2 = { action: 'none' };
  }
  if (s2.action === 'resolve') {
    return {
      id: s2.entityId,
      created: false,
      stage: 2,
      similarity: s2.similarity,
      embedding_source: null,
    };
  }

  // Stage 3 — LLM disambig (only when host is provided and stage 2 escalated).
  if (s2.action === 'escalate' && host?.invokeLLM) {
    const s3 = await stage3Disambig(host, {
      mention: name,
      type,
      candidates: s2.candidates,
    });
    if (s3.action === 'resolve') {
      return { id: s3.entityId, created: false, stage: 3, embedding_source: null };
    }
  }

  // Create — use a deterministic record id keyed by (type, name_lower) so
  // concurrent upserts converge to the same row instead of racing.
  const stableKey = `${type}__${name.toLowerCase()}`;
  const fields = {
    name,
    type,
    scope,
    tags,
    ...(meta ? { meta } : {}),
  };
  const [created] = await db
    .query("UPSERT type::record('entities', $key) CONTENT $fields", {
      key: stableKey,
      fields,
    })
    .collect();
  const row = Array.isArray(created) ? created[0] : created;
  return {
    id: row.id,
    created: true,
    stage: 0,
    embedding_source: `${type}: ${name}`,
  };
}
