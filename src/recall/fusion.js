// fusion.js — reciprocal rank fusion + distance padding for hybrid retrieval.
//
// Spec: 2026-05-11-surrealdb-improvements-design.md (section 2). The kNN and
// BM25 retrievers each rank candidates by their own score; RRF combines the
// rankings into a single fused order. BM25-only hits get a neutral cosine
// distance (0.5) so downstream rank.score() doesn't underrank them.

const DEFAULT_RRF_K = 60;

/**
 * Reciprocal Rank Fusion. Accepts N ranked lists and returns one fused list
 * sorted by ∑ 1 / (k + rank). The fusion is stable across ranker disagreements
 * (a hit ranked highly in either lane bubbles up).
 *
 * Each hit object must have a comparable `id` (string or RecordId). Hits may
 * carry a `_source` tag (e.g. 'knn', 'bm25') which is propagated to the fused
 * record as `_sources: ['knn', 'bm25']`.
 *
 * @param {Array<Array<{id:*, _source?:string}>>} rankings
 * @param {{ k?: number }} [opts]
 */
export function rrfFuse(rankings, { k = DEFAULT_RRF_K } = {}) {
  const scores = new Map();
  for (const list of rankings) {
    if (!Array.isArray(list)) continue;
    list.forEach((hit, rank) => {
      const id = String(hit.id);
      const cur = scores.get(id) ?? { record: hit, rrf: 0, sources: new Set() };
      cur.rrf += 1 / (k + rank);
      if (hit._source) cur.sources.add(hit._source);
      // Carry the first non-null distance through (kNN-source preferred).
      if (cur.record.distance == null && hit.distance != null) {
        cur.record = { ...cur.record, distance: hit.distance };
      }
      scores.set(id, cur);
    });
  }
  return [...scores.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .map((s) => ({ ...s.record, _rrf: s.rrf, _sources: [...s.sources] }));
}

/**
 * Items reached only via BM25 have no cosine distance. Pad with 0.5 (neutral)
 * so rank.score()'s cosineSim component contributes a middle value rather
 * than zero. The RRF order already shaped the fused list; this just lets the
 * downstream composite scorer run without NaNs.
 */
export function padDistances(fused) {
  return fused.map((h) => ({ ...h, distance: h.distance ?? 0.5 }));
}
