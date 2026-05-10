import { surql } from 'surrealdb';

export async function embedBackfillTick({ db, embedder, batch = 64, log = () => {} }) {
  const [rows] = await db
    .query(surql`
      SELECT id, content, ts FROM events
      WHERE embedding IS NONE AND meta.embed_failed IS NOT true
      ORDER BY ts ASC
      LIMIT ${batch}
    `)
    .collect();
  if (!rows || rows.length === 0) return { embedded: 0, failed: 0 };
  const start = Date.now();
  let embedded = 0;
  let failed = 0;

  // Try whole-batch first; fall back to per-row on batch failure.
  let vecs;
  try {
    vecs = await embedder.embedBatch(rows.map((r) => r.content));
  } catch {
    vecs = null;
  }

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      const v = vecs ? vecs[i] : await embedder.embed(r.content);
      const arr = Array.from(v);
      await db
        .query(surql`UPDATE ${r.id} SET embedding = ${arr}, embedded_at = time::now()`)
        .collect();
      embedded++;
    } catch {
      try {
        await db.query(surql`UPDATE ${r.id} SET meta.embed_failed = true`).collect();
      } catch {
        /* swallow secondary failure */
      }
      failed++;
    }
  }

  log(`[embed_backfill] embedded ${embedded}, failed ${failed} (latency ${Date.now() - start}ms)`);
  return { embedded, failed };
}
