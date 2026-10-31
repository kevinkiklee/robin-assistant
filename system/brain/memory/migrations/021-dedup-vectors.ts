import { pruneNoiseVectors, rebuildVecIndex } from '../prune-noise.ts';
import type { Migration } from './types.ts';

export const migration021: Migration = {
  version: 21,
  name: 'dedup-vectors-prune-noise',
  up: (db) => {
    // Tier 1 — drop vectors for noise kinds (operational acks, integration ticks,
    // finance line-items, music plays). They stay FTS-searchable in events_content;
    // only the vector + its events_vec row are removed. Shrinks the brute-force KNN
    // scan set. See embed-policy.ts for the denylist.
    pruneNoiseVectors(db);

    // Tier 2 — the embedding column is only ever NULL-checked (embedder eligibility +
    // the vec.index_synced invariant); recall reads vectors from events_vec, never from
    // here. Storing the full 3072-d float32 vector in BOTH places doubled vector storage
    // (~381 MB on the live DB). Compress every remaining full-vector BLOB to a 1-byte
    // sentinel (mirrors EMBEDDED_SENTINEL in reindex.ts). Pages are freed logically; a
    // VACUUM after the migration reclaims the file size (VACUUM can't run in a tx).
    db.exec(`UPDATE events_content SET embedding = x'01' WHERE embedding IS NOT NULL`);

    // Reclaim the pruned vectors' disk space. vec0 keeps deleted rows' chunk bytes on
    // disk even after VACUUM, so the prune above is only logical until events_vec is
    // rebuilt from its surviving rows (observed: 564 MB → 264 MB). Run a VACUUM after
    // this migration to release the freed pages.
    rebuildVecIndex(db);
  },
};
