// knowledge.js — distilled facts (memos kind='knowledge').
// Spec §5 / kept name; refactored to be a thin lens over store.

import { BoundQuery } from 'surrealdb';
import * as store from './store.js';

/**
 * Create a knowledge memo. Content-hash dedup is applied by `store.note`.
 */
export async function createKnowledge(db, embedder, input) {
  const { content, subject_id, confidence, source_events = [], source_episodes = [], meta } = input;
  // Merge legacy source_events + source_episodes into the new `lineage` shape
  // (`derived_from` edges emitted by store.note).
  const lineage = [
    ...source_events.map((id) => ({ id, kind: 'event' })),
    ...source_episodes.map((id) => ({ id, kind: 'episode' })),
  ];
  return store.note(db, embedder, 'knowledge', {
    content,
    confidence,
    derived_by: input.derived_by ?? 'dream',
    subjects: subject_id ? [subject_id] : [],
    lineage,
    meta,
  });
}

/**
 * Look up a knowledge memo by content hash (dedup helper).
 */
export async function getKnowledgeByContentHash(db, content) {
  const { sha256 } = await import('../../data/embed/hash.js');
  const hash = sha256(content);
  const [rows] = await db
    .query(
      new BoundQuery(
        "SELECT id FROM memos WHERE kind = 'knowledge' AND content_hash = $h LIMIT 1",
        { h: hash },
      ),
    )
    .collect();
  return rows[0] ?? null;
}

export async function listKnowledge(db, { subject_id, limit = 50 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error(`listKnowledge: limit out of range [1,1000]: ${limit}`);
  }
  if (subject_id) {
    // Subject linkage moved from a scalar field to `about` edges.
    const sql = `
      SELECT id, content, confidence, derived_at AS created_at
      FROM memos
      WHERE kind = 'knowledge'
        AND id IN (SELECT VALUE in FROM edges WHERE kind = 'about' AND out = $sid)
      ORDER BY derived_at DESC LIMIT ${limit}
    `;
    const [rows] = await db.query(new BoundQuery(sql, { sid: subject_id })).collect();
    return rows;
  }
  const sql = `
    SELECT id, content, confidence, derived_at AS created_at
    FROM memos WHERE kind = 'knowledge'
    ORDER BY derived_at DESC LIMIT ${limit}
  `;
  const [rows] = await db.query(sql).collect();
  return rows;
}

/**
 * HNSW vector search over knowledge memos.
 * Delegates to store.searchMemos which queries the active profile's
 * embeddings_<profile>_memos table.
 */
export async function searchKnowledge(db, embedder, query, { limit = 10 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error(`searchKnowledge: limit out of range [1,100]: ${limit}`);
  }
  const { hits } = await store.searchMemos(db, embedder, query, {
    kind: 'knowledge',
    limit,
  });
  return hits.map((h) => ({
    id: h.record.id,
    content: h.record.content,
    confidence: h.record.confidence,
    dist: h.distance,
  }));
}
