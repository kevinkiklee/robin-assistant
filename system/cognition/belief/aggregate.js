// aggregate.js — pure aggregation for the belief() tool.
// Spec §2. No DB imports; tests feed in shaped hits directly. Caller is
// responsible for batched fetches of structural-weight components (signal_count,
// decay, supersedes-count) and derived_confidence; this function combines them.
//
// Hit shape (one per surviving memo):
//   { id, dist, structural, derived }
//     - id: record-id string for sort stability + evidence kept_ids
//     - dist: HNSW cosine distance (relevance = 1 - dist; in [0,1])
//     - structural: signal_count × decay (already includes reinforced;
//       supersedes-zero rule applied by caller via decay=0)
//     - derived: derived_confidence in [0,1]; fallback to stored confidence
//       is the caller's responsibility (per spec §2.4 note).

const ZERO_WEIGHT_EPSILON = 1e-12;

/**
 * @param {Array<{id:string|object,dist:number,structural:number,derived:number}>} hits
 * @param {{relevance_threshold:number, confidence_floor:number}} cfg
 * @returns {{
 *   aggregate: number,
 *   weights: number[],
 *   kept_ids: string[],
 *   k_returned: number,
 *   fallback_path: null | 'no_hits' | 'all_below_relevance',
 *   hits_dropped_relevance: number,
 * }}
 */
export function aggregateBelief(hits, cfg) {
  const minRel = cfg.relevance_threshold ?? 0.3;
  const minConf = cfg.confidence_floor ?? 0.05;

  if (!Array.isArray(hits) || hits.length === 0) {
    return {
      aggregate: 0,
      weights: [],
      kept_ids: [],
      k_returned: 0,
      fallback_path: 'no_hits',
      hits_dropped_relevance: 0,
    };
  }

  let dropped = 0;
  const keep = [];
  for (const h of hits) {
    const relevance = 1 - (h.dist ?? 0);
    if (relevance < minRel) {
      dropped++;
      continue;
    }
    if ((h.derived ?? 0) < minConf) {
      dropped++;
      continue;
    }
    // Confidence multiplier is NOT in the weight (spec §2.3).
    const weight_raw = (h.structural ?? 0) * relevance;
    keep.push({ id: h.id, weight_raw, relevance, derived: h.derived ?? 0 });
  }

  if (keep.length === 0) {
    return {
      aggregate: 0,
      weights: [],
      kept_ids: [],
      k_returned: 0,
      fallback_path: 'all_below_relevance',
      hits_dropped_relevance: dropped,
    };
  }

  const sumRaw = keep.reduce((s, k) => s + k.weight_raw, 0);
  if (sumRaw < ZERO_WEIGHT_EPSILON) {
    // Every surviving hit had weight_raw=0 — typically because all memos
    // were superseded → decay=0. Spec §2.3: collapse to no_hits path.
    return {
      aggregate: 0,
      weights: [],
      kept_ids: [],
      k_returned: 0,
      fallback_path: 'no_hits',
      hits_dropped_relevance: dropped,
    };
  }

  for (const k of keep) k.weight = k.weight_raw / sumRaw;
  keep.sort((a, b) => b.weight - a.weight || String(a.id).localeCompare(String(b.id)));

  let agg = 0;
  for (const k of keep) agg += k.weight * k.derived;
  if (agg < 0) agg = 0;
  if (agg > 1) agg = 1;

  return {
    aggregate: agg,
    weights: keep.map((k) => k.weight),
    kept_ids: keep.map((k) => String(k.id)),
    k_returned: keep.length,
    fallback_path: null,
    hits_dropped_relevance: dropped,
  };
}
