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

import { isSafeRecordRef } from '../memory/edge-registry.js';
import { stage1Resolve } from './stage1-exact.js';
import { stage2Resolve } from './stage2-embedding.js';
import { stage3Disambig } from './stage3-disambig.js';

const DEFAULT_HIGH = 0.92;
const DEFAULT_LOW = 0.85;

// SurrealDB renders record IDs outside `[A-Za-z0-9_]` as `tb:⟨…⟩` /
// backticks, and that bracketed form fails to round-trip through a bound
// INSERT RELATION parameter. `cognition/memory/edge-registry.validateEdge`
// rejects unsafe keys outright, so every entity record id must pass
// through this sanitizer. Exported so the v1-import entity-writer produces
// the same key for the same (type, name) and re-imports converge onto the
// row created by the biographer (and vice versa).
export function entityRecordKey(type, name) {
  const safeName =
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'unnamed';
  return `${type}__${safeName}`;
}

export async function upsertEntityCascade(db, embedder, input) {
  const { name, type, scope = 'global', tags = [], meta, host, config = {} } = input;
  if (!name) throw new Error('upsertEntityCascade: name required');
  if (!type) throw new Error('upsertEntityCascade: type required');

  const highThreshold = config.stage2_high_threshold ?? DEFAULT_HIGH;
  const lowThreshold = config.stage2_low_threshold ?? DEFAULT_LOW;

  // Stage 1 — exact (no embedding needed). Skip unsafe-key matches: legacy
  // rows whose id key contains spaces / dots / dashes round-trip-fail in
  // INSERT RELATION, which silently drops every edge slice that references
  // them. Falling through to stage 2 / create lets us pair the bad row with
  // a sanitized-key sibling that future edges can target.
  const s1 = await stage1Resolve(db, { name, type });
  if (s1 && isSafeRecordRef(s1)) {
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
      // Stage 2 is best-effort during the schema-redesign transition. We
      // record `error` on the result for callers that inspect it, but also
      // log so failures surface in daemon.log instead of disappearing — a
      // sustained Stage 2 outage (embedder mismatch, schema reject) was hard
      // to spot when the catch was completely silent.
      console.warn(`upsert-entity: stage2 failed for "${name}" (${type}): ${e?.message ?? e}`);
      s2 = { action: 'none', error: String(e?.message ?? e) };
    }
  } else {
    s2 = { action: 'none' };
  }
  if (s2.action === 'resolve' && isSafeRecordRef(s2.entityId)) {
    return {
      id: s2.entityId,
      created: false,
      stage: 2,
      similarity: s2.similarity,
      embedding_source: null,
    };
  }

  // Stage 3 — LLM disambig (only when host is provided and stage 2 escalated).
  // Filter unsafe-key candidates out before sending to the LLM so it can't
  // pick one that would re-poison the edge writes.
  if (s2.action === 'escalate' && host?.invokeLLM) {
    const safeCandidates = (s2.candidates ?? []).filter((c) => isSafeRecordRef(c.id));
    if (safeCandidates.length > 0) {
      const s3 = await stage3Disambig(host, {
        mention: name,
        type,
        candidates: safeCandidates,
      });
      if (s3.action === 'resolve' && isSafeRecordRef(s3.entityId)) {
        return { id: s3.entityId, created: false, stage: 3, embedding_source: null };
      }
    }
  }

  // Create — use a deterministic record id keyed by (type, name_lower) so
  // concurrent upserts converge to the same row instead of racing.
  // Stage-1 name lookup still searches by the `name_lower` field (which
  // keeps the original string) so the sanitization only changes the
  // record ID shape, not the resolution path.
  const stableKey = entityRecordKey(type, name);
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
