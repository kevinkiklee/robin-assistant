// vectors.js — embedding-vector hydration + cosine similarity for A1 MMR.
//
// Both helpers are used by inject.js between merge/sort and MMR. The DB
// fetch is batched: one query per non-empty surface (events, memos), keyed
// by record. Profile resolution goes through profile-router so we read from
// the currently-active embedding table.

import { BoundQuery } from 'surrealdb';
import { embeddingTable, readProfile } from '../../data/embed/profile-router.js';
import { recordStringId } from '../memory/edge-registry.js';

/**
 * @param {Float32Array|number[]|null|undefined} a
 * @param {Float32Array|number[]|null|undefined} b
 * @returns {number} cosine ∈ [-1, 1], or 0 if comparison is impossible.
 */
export function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Fetch current embedding vectors for a set of event + memo record ids.
 * Returns a Map keyed by `String(id)`, value = Float32Array. Missing ids
 * are simply absent from the Map; callers should treat missing as "cannot
 * compare" rather than as "is dissimilar".
 *
 * @param {import('surrealdb').Surreal} db
 * @param {{ eventIds?: Array<any>, memoIds?: Array<any> }} ids
 * @returns {Promise<Map<string, Float32Array>>}
 */
export async function loadVectorsForHits(db, { eventIds = [], memoIds = [] }) {
  const out = new Map();
  if (eventIds.length === 0 && memoIds.length === 0) return out;

  const profile = await readProfile(db);

  if (eventIds.length > 0) {
    const tbl = embeddingTable(profile, 'events');
    const [rows] = await db
      .query(
        new BoundQuery(`SELECT record, vector FROM ${tbl} WHERE record IN $ids`, {
          ids: eventIds,
        }),
      )
      .collect();
    for (const r of rows ?? []) {
      const key = recordStringId(r.record);
      if (key) out.set(key, Float32Array.from(r.vector));
    }
  }
  if (memoIds.length > 0) {
    const tbl = embeddingTable(profile, 'memos');
    const [rows] = await db
      .query(
        new BoundQuery(`SELECT record, vector FROM ${tbl} WHERE record IN $ids`, {
          ids: memoIds,
        }),
      )
      .collect();
    for (const r of rows ?? []) {
      const key = recordStringId(r.record);
      if (key) out.set(key, Float32Array.from(r.vector));
    }
  }
  return out;
}
