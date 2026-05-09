import { BoundQuery, surql } from 'surrealdb';
import { sha256 } from '../embed/hash.js';

/**
 * Distilled long-term facts produced by the dream agent.
 *
 * - Content-hash dedupe: identical `content` returns the existing row.
 * - 384-dim embedding (HNSW indexed) is computed at write time only when the
 *   row is actually new — duplicate writes skip the embed call.
 */
export async function createKnowledge(db, embedder, input) {
  const { content, subject_id, confidence, source_events, source_episodes, meta } = input;
  if (!content || content.length === 0) throw new Error('content required');
  const content_hash = sha256(content);
  const existing = await getKnowledgeByContentHash(db, content);
  if (existing) {
    return { id: existing.id, deduped: true };
  }
  const embedding = Array.from(await embedder.embed(content));
  const fields = {
    content,
    content_hash,
    confidence,
    source_events,
    source_episodes,
    embedding,
    ...(subject_id ? { subject_id } : {}),
    ...(meta ? { meta } : {}),
  };
  const [created] = await db.query(surql`CREATE knowledge CONTENT ${fields}`).collect();
  const row = Array.isArray(created) ? created[0] : created;
  return { id: row.id };
}

export async function getKnowledgeByContentHash(db, content) {
  const hash = sha256(content);
  const [rows] = await db
    .query(surql`SELECT id FROM knowledge WHERE content_hash = ${hash} LIMIT 1`)
    .collect();
  return rows[0] ?? null;
}

export async function listKnowledge(db, { subject_id, limit = 50 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error(`listKnowledge: limit out of range [1,1000]: ${limit}`);
  }
  if (subject_id) {
    const sql = `SELECT id, content, subject_id, confidence, created_at FROM knowledge WHERE subject_id = $sid ORDER BY created_at DESC LIMIT ${limit}`;
    const [rows] = await db.query(new BoundQuery(sql, { sid: subject_id })).collect();
    return rows;
  }
  const sql = `SELECT id, content, subject_id, confidence, created_at FROM knowledge ORDER BY created_at DESC LIMIT ${limit}`;
  const [rows] = await db.query(sql).collect();
  return rows;
}

/**
 * HNSW vector search over `knowledge.embedding`.
 *
 * KNN K (=`limit`) must be a literal integer — the SurrealDB parser rejects
 * `$bind_N` in `<|K, EF|>`. We validate `limit` and interpolate it; the query
 * vector is parameterised via BoundQuery.
 */
export async function searchKnowledge(db, embedder, query, { limit = 10 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error(`searchKnowledge: limit out of range [1,100]: ${limit}`);
  }
  const qvec = Array.from(await embedder.embed(query));
  const sql = `
    SELECT id, content, subject_id, confidence, vector::distance::knn() AS dist
    FROM knowledge
    WHERE embedding <|${limit}, 64|> $qvec
    ORDER BY dist
    LIMIT ${limit}
  `;
  const [rows] = await db.query(new BoundQuery(sql, { qvec })).collect();
  return rows;
}
