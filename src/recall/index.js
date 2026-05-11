// recall/index.js — vector search over events, redirected to the active
// profile's embeddings table via store.searchEvents.
//
// The old `events.embedding` inline column is gone (Wave 1). Recall now hits
// `embeddings_<profile>_events` for the HNSW kNN, then JOINs back to events.
//
// Spec §7. Returns `{ hits: [{ id, source, content, ts, meta, dist }] }` for
// backward compatibility with intuition.js's expectations.

import * as store from '../memory/store.js';

/**
 * @param {import('surrealdb').Surreal} db
 * @param {{embed:(t:string)=>Promise<Float32Array>}} embedder
 * @param {string} query
 * @param {{
 *   limit?: number,
 *   source?: string|null,
 *   since?: Date|string|null,
 *   until?: Date|string|null,
 * }} [opts]
 */
export async function recall(db, embedder, query, opts = {}) {
  const limit = Number.isInteger(opts.limit) ? opts.limit : 10;
  if (limit < 1 || limit > 100) {
    throw new Error(`recall: limit out of range [1,100]: ${limit}`);
  }

  const searchOpts = { limit };
  if (opts.source != null) searchOpts.source = opts.source;
  if (opts.since != null) searchOpts.since = opts.since;
  if (opts.until != null) searchOpts.until = opts.until;

  const { hits } = await store.searchEvents(db, embedder, query, searchOpts);

  // Adapt to legacy shape — callers expect `{ hits: [{id, source, content, ts, meta, dist}] }`.
  return {
    hits: hits.map((h) => ({
      id: h.record.id,
      source: h.record.source,
      content: h.record.content,
      ts: h.record.ts,
      meta: h.record.meta,
      dist: h.distance,
    })),
  };
}
