import { BoundQuery, surql } from 'surrealdb';
import { activeProfile, embeddingTable } from './profile-router.js';

// Backfill embeddings for events that have no row in the active profile's
// events embedding surface. The new schema keeps embeddings in a per-profile
// table (`embeddings_<profile>_events`), so the missing-embedding check is a
// LEFT-anti-join rather than a column predicate.
export async function embedBackfillTick({ db, embedder, batch = 64, log = () => {} }) {
  const profile = await activeProfile(db);
  const eventsEmbTbl = embeddingTable(profile, 'events');

  const selectSql = `
    SELECT id, content, ts FROM events
    WHERE meta.embed_failed IS NOT true
      AND id NOT IN (SELECT VALUE record FROM ${eventsEmbTbl})
    ORDER BY ts ASC
    LIMIT ${batch}
  `;
  const [rows] = await db.query(selectSql).collect();
  if (!rows || rows.length === 0) return { embedded: 0, failed: 0 };

  const start = Date.now();
  let embedded = 0;
  let failed = 0;

  // Try whole-batch first; fall back to per-row on batch failure.
  let vecs;
  try {
    vecs = await embedder.embedBatch(rows.map((r) => r.content));
  } catch (err) {
    vecs = null;
    log?.(`embedBatch failed; falling back to per-row: ${err.message ?? err}`);
  }

  const upsertSql =
    'UPSERT type::record($tb, [$rec]) SET record = $rec, vector = $vec, ts = time::now()';

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      const v = vecs ? vecs[i] : await embedder.embed(r.content);
      const arr = Array.from(v);
      await db
        .query(new BoundQuery(upsertSql, { tb: eventsEmbTbl, rec: r.id, vec: arr }))
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
