import type { RobinDb } from './db.ts';
import { deniedKindSql } from './embed-policy.ts';

export interface PruneResult {
  /** events_vec rows removed. */
  deletedVectors: number;
  /** events_content rows whose embedding was nulled. */
  nulledContent: number;
}

/**
 * One-time cleanup of vectors that the embed-policy now forbids. For every content
 * row owned by a denied (noise) event kind, delete its events_vec row and null its
 * events_content.embedding. This shrinks the brute-force KNN scan set and the vector
 * store, and keeps the two in lockstep so the `vec.index_synced` invariant
 * (count(embedding NOT NULL) === count(events_vec)) stays satisfied.
 *
 * Idempotent: rows already pruned (embedding IS NULL) are not selected again.
 * The actual disk reclamation needs a `VACUUM` after this runs (callers/migrations
 * handle that outside the enclosing transaction — VACUUM can't run inside one).
 */
export function pruneNoiseVectors(db: RobinDb): PruneResult {
  const denied = deniedKindSql('e.kind');
  const ids = db
    .prepare(
      `SELECT DISTINCT ec.id AS id
         FROM events_content ec
         JOIN events e ON e.content_ref = ec.id
        WHERE ${denied.sql} AND ec.embedding IS NOT NULL`,
    )
    .all(...denied.params) as Array<{ id: number }>;

  if (ids.length === 0) return { deletedVectors: 0, nulledContent: 0 };

  const delVec = db.prepare(`DELETE FROM events_vec WHERE rowid = ?`);
  const nullEmb = db.prepare(`UPDATE events_content SET embedding = NULL WHERE id = ?`);
  let deletedVectors = 0;

  const tx = db.transaction(() => {
    for (const { id } of ids) {
      // vec0 rowid bindings reject JS Number (see reindex.ts) — use BigInt.
      const info = delVec.run(BigInt(id));
      deletedVectors += info.changes;
      nullEmb.run(id);
    }
  });
  tx();

  return { deletedVectors, nulledContent: ids.length };
}

/**
 * Rebuild events_vec from its live rows to reclaim disk. sqlite-vec's vec0 never
 * releases its `*_vector_chunks00` storage on DELETE — even after VACUUM — so a table
 * with many deleted rows keeps the deleted vectors' bytes on disk. Recreating the
 * table from scratch packs only the surviving rows (observed: 564 MB → 264 MB after a
 * one-third prune). vec0 has no RENAME, so we stage into a tmp table, recreate
 * events_vec fresh, and copy back. The recall JOIN depends on `events_vec.rowid ===
 * events_content.id`, so rowids are preserved exactly. Returns the row count carried
 * over. Run a VACUUM afterwards to release the pages freed by the dropped table.
 */
export function rebuildVecIndex(db: RobinDb): number {
  const copy = (from: string, to: string): number => {
    const ins = db.prepare(`INSERT INTO ${to}(rowid, embedding) VALUES (?, ?)`);
    const rows = db.prepare(`SELECT rowid, embedding FROM ${from}`).all() as Array<{
      rowid: number;
      embedding: Buffer;
    }>;
    for (const r of rows) ins.run(BigInt(r.rowid), r.embedding);
    return rows.length;
  };

  return db.transaction(() => {
    db.exec(`CREATE VIRTUAL TABLE events_vec_tmp USING vec0(embedding float[3072])`);
    copy('events_vec', 'events_vec_tmp');
    db.exec(`DROP TABLE events_vec`);
    db.exec(`CREATE VIRTUAL TABLE events_vec USING vec0(embedding float[3072])`);
    const moved = copy('events_vec_tmp', 'events_vec');
    db.exec(`DROP TABLE events_vec_tmp`);
    return moved;
  })();
}
