import { BoundQuery } from 'surrealdb';

/**
 * Cascade Stage 2: embedding similarity via HNSW.
 *
 * Embeds `<type>: <name>` and runs KNN over the `entities_vec` HNSW index,
 * scoped to the requested type. Returns one of:
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

export async function stage2Resolve(db, embedder, { name, type, highThreshold, lowThreshold }) {
  const qvec = Array.from(await embedder.embed(`${type}: ${name}`));

  // K (=TOP_K) is a validated integer constant, so interpolating it is safe.
  // qvec and type are parameterized via BoundQuery.
  const sql = `
    SELECT id, name, vector::distance::knn() AS dist
    FROM entities
    WHERE embedding <|${TOP_K}, 64|> $qvec
      AND type = $type
    ORDER BY dist
    LIMIT ${TOP_K};
  `;
  const [rows] = await db.query(new BoundQuery(sql, { qvec, type })).collect();
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
