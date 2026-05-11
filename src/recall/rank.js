// rank.js — composite recall ranking + MMR-lite diversity.
// Spec §6.6, §7.2.
//
// score = cosine_sim × freshness × contradiction_penalty × trust_factor × scope_boost
// where:
//   cosine_sim          ∈ [0,1]   = 1 - distance
//   freshness           ∈ [0,1]   = decay.freshness(record, { supersededCount })
//   contradiction_penalty ∈ [0.1,1.0] = max(0.1, 1 - 0.3 * contradictionCount)
//   trust_factor        ∈ [0,1]   = lookup table per derived_by / source
//   scope_boost         ∈ [1.0,1.2] = 1.2 if record.scope matches caller-scope, else 1.0

import { freshness } from '../memory/decay.js';

export const TRUST_FACTOR = {
  manual: 1.0,
  trusted: 1.0,
  biographer: 0.95,
  dream: 0.9,
  reflection: 0.9,
  ingest: 0.95,
  derived: 0.85,
  action_outcome: 0.85,
  agent: 0.85,
  untrusted: 0.5,
};

/**
 * Compute the ranking score for a single hit.
 *
 * @param {{
 *   record: { kind?: string, confidence?: number, signal_count?: number,
 *             decay_anchor?: any, derived_by?: string, source?: string, scope?: string },
 *   distance: number,
 *   supersededCount?: number,
 *   contradictionCount?: number,
 * }} hit
 * @param {{ scope?: string, session_id?: string }} [callerCtx]
 */
export function score(hit, callerCtx = {}) {
  const { record, distance, supersededCount = 0, contradictionCount = 0 } = hit;

  const cosineSim = Math.max(0, Math.min(1, 1 - (distance ?? 0)));
  const fresh = freshness(
    { kind: record.kind, confidence: record.confidence, signal_count: record.signal_count, decay_anchor: record.decay_anchor },
    { supersededCount },
  );
  const contraPenalty = Math.max(0.1, 1 - 0.3 * contradictionCount);
  const trustKey = record.derived_by ?? record.source ?? 'manual';
  const trustFactor = TRUST_FACTOR[trustKey] ?? 0.9;
  const scopeBoost = _scopeBoost(record.scope, callerCtx);

  const total = cosineSim * fresh * contraPenalty * trustFactor * scopeBoost;
  return {
    score: total,
    components: { cosineSim, fresh, contraPenalty, trustFactor, scopeBoost },
  };
}

function _scopeBoost(recordScope, ctx) {
  if (!recordScope || recordScope === 'global') return 1.0;
  if (ctx.scope && recordScope === ctx.scope) return 1.2;
  if (ctx.session_id && recordScope === `session:${ctx.session_id}`) return 1.2;
  return 1.0;
}

/**
 * MMR-lite: suppress any hit whose cosine to a higher-ranked hit exceeds
 * `threshold`. Caller must provide pairwise cosine via `cosineFn(hitA, hitB)`.
 *
 * Returns the input array, re-ordered with suppressed hits dropped.
 */
export function mmrLite(rankedHits, cosineFn, threshold = 0.92) {
  if (rankedHits.length <= 1) return rankedHits;
  const kept = [];
  for (const hit of rankedHits) {
    let tooSimilar = false;
    for (const k of kept) {
      const sim = cosineFn(hit, k);
      if (sim > threshold) {
        tooSimilar = true;
        break;
      }
    }
    if (!tooSimilar) kept.push(hit);
  }
  return kept;
}

/**
 * Pairwise cosine similarity from two embedding vectors. Used by the MMR pass
 * when the embeddings are already in hand (e.g. from a recent kNN result).
 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let aMag = 0;
  let bMag = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aMag += a[i] * a[i];
    bMag += b[i] * b[i];
  }
  if (aMag === 0 || bMag === 0) return 0;
  return dot / (Math.sqrt(aMag) * Math.sqrt(bMag));
}
