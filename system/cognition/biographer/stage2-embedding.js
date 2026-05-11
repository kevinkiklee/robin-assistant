import { BoundQuery } from 'surrealdb';
import { activeProfile, embeddingTable } from '../../data/embed/profile-router.js';

/**
 * Cascade Stage 2: embedding similarity via HNSW.
 *
 * Embeds `<type>: <name>` and runs KNN over the per-profile
 * `embeddings_<profile>_entities` HNSW index, then joins back to entities
 * filtering by the requested type. Returns one of:
 *   - { action: 'resolve', entityId, similarity } when best ≥ highThreshold
 *   - { action: 'escalate', candidates }          when some ≥ lowThreshold
 *   - { action: 'none' }                          otherwise
 *
 * SurrealDB v3 quirk: KNN K must be a literal integer (parser rejects bound
 * params there). TOP_K is a validated module-level constant, so interpolating
 * it into the SQL is safe. All other inputs (vector, type) are parameterized
 * via BoundQuery — same pattern as src/recall/index.js.
 *
 * @param {import('surrealdb').Surreal} db
 * @param {{embed:(t:string)=>Promise<Float32Array>}} embedder
 * @param {{name:string, type:string, highThreshold:number, lowThreshold:number}} opts
 */
const TOP_K = 5;
const EF = 64;

export async function stage2Resolve(db, embedder, { name, type, highThreshold, lowThreshold }) {
  const qvec = Array.from(await embedder.embed(`${type}: ${name}`));

  // 1. HNSW over the per-(profile) entities embedding surface.
  const profile = await activeProfile(db);
  const embTbl = embeddingTable(profile, 'entities');
  const knnSql = `
    SELECT record, vector::distance::knn() AS dist
    FROM ${embTbl}
    WHERE vector <|${TOP_K}, ${EF}|> $qvec
    ORDER BY dist
    LIMIT ${TOP_K}
  `;
  const [knnRows] = await db.query(new BoundQuery(knnSql, { qvec })).collect();
  if (!knnRows || knnRows.length === 0) return { action: 'none' };

  // 2. Hydrate + filter by type. Keep KNN order.
  const ids = knnRows.map((r) => r.record);
  const idDist = new Map(knnRows.map((r) => [String(r.record), r.dist]));
  const [hydrated] = await db
    .query(
      new BoundQuery('SELECT id, name FROM entities WHERE id IN $ids AND type = $type', {
        ids,
        type,
      }),
    )
    .collect();
  const rows = hydrated
    .map((r) => ({ id: r.id, name: r.name, dist: idDist.get(String(r.id)) ?? 1 }))
    .sort((a, b) => a.dist - b.dist);
  if (!rows || rows.length === 0) return { action: 'none' };

  // dist is cosine distance (0 = identical); similarity = 1 - dist.
  const candidates = rows.map((r) => ({
    id: r.id,
    name: r.name,
    similarity: 1 - r.dist,
  }));
  const best = candidates[0];
  if (best.similarity >= highThreshold) {
    return { action: 'resolve', entityId: best.id, similarity: best.similarity };
  }
  const aboveLow = candidates.filter((c) => c.similarity >= lowThreshold);
  if (aboveLow.length === 0) return { action: 'none' };
  return { action: 'escalate', candidates: aboveLow.slice(0, 3) };
}
