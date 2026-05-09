import { BoundQuery } from 'surrealdb';

/**
 * Internal recall: vector search over `events` with optional source/time filters.
 *
 * Two SurrealDB v3 / SDK v2 quirks worth noting:
 *
 * 1. KNN K must be a literal integer.
 *    The KNN operator `<|K, EF|>` requires K to be a literal unsigned integer.
 *    `surql`-tagged values become `$bind_N`, which the parser rejects with
 *    "Unexpected token `a parameter`, expected an unsigned integer". So we
 *    build a `BoundQuery` manually: `limit` is validated to an integer in
 *    [1,100] and string-interpolated; everything else is parameterized.
 *
 * 2. JS `null` is bound as SurrealQL `NULL`, not `NONE`.
 *    The plan suggested `($x IS NONE OR field = $x)` to make filters optional,
 *    but `null IS NONE` evaluates false at runtime (we observed an empty
 *    result set when no filter was passed). Building the WHERE clause
 *    conditionally on the JS side is cleanest and avoids that ambiguity.
 *
 * @param {import('surrealdb').Surreal} db
 * @param {{embed:(t:string)=>Promise<Float32Array>}} embedder
 * @param {string} query
 * @param {{
 *   limit?: number,
 *   source?: string|null,
 *   since?: Date|string|null,
 *   until?: Date|string|null,
 *   explain?: boolean,
 * }} [opts]
 */
export async function recall(db, embedder, query, opts = {}) {
  const limit = Number.isInteger(opts.limit) ? opts.limit : 10;
  if (limit < 1 || limit > 100) {
    throw new Error(`recall: limit out of range [1,100]: ${limit}`);
  }
  const qvec = Array.from(await embedder.embed(query));
  const bindings = { qvec };
  const filters = [];
  if (opts.source != null) {
    bindings.source = opts.source;
    filters.push('source = $source');
  }
  if (opts.since != null) {
    bindings.since = new Date(opts.since);
    filters.push('ts > $since');
  }
  if (opts.until != null) {
    bindings.until = new Date(opts.until);
    filters.push('ts < $until');
  }
  const filterClause = filters.length > 0 ? ` AND ${filters.join(' AND ')}` : '';

  // K (=`limit`) is a validated integer, so string interpolation here is safe.
  const sql = `
    SELECT id, source, content, ts, meta, vector::distance::knn() AS dist
    FROM events
    WHERE embedding <|${limit}, 64|> $qvec${filterClause}
    ORDER BY dist
    LIMIT ${limit};
  `;
  const [hits] = await db.query(new BoundQuery(sql, bindings)).collect();

  let explain;
  if (opts.explain) {
    const explainSql = `
      SELECT id, vector::distance::knn() AS dist FROM events
      WHERE embedding <|${limit}, 64|> $qvec${filterClause}
      ORDER BY dist
      LIMIT ${limit}
      EXPLAIN FULL;
    `;
    const [exp] = await db.query(new BoundQuery(explainSql, bindings)).collect();
    explain = JSON.stringify(exp, null, 2);
  }

  return { hits, ...(explain ? { explain } : {}) };
}
