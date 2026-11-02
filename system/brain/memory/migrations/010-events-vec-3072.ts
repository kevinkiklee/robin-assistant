import type { Migration } from './types.ts';

export const migration010: Migration = {
  version: 10,
  name: 'events-vec-3072',
  up: (db) => {
    // Switching the embedder from qwen3-embedding:8b (4096-dim) to Gemini Embedding 2
    // (3072-dim). vec0 virtual tables have a fixed embedding width, so the dimension
    // change requires dropping and recreating events_vec.
    //
    // Dropping is safe here because a full DB backup is taken before this migration runs,
    // and every row is re-embedded via `robin reindex --force` immediately afterward. We do
    // NOT project the old vectors into the new space: 4096-dim qwen vectors are not
    // semantically comparable to 3072-dim Gemini vectors, so a fresh reindex — not a
    // projection — is the correct move. Recall falls back to lexical/FTS5 search until the
    // backfill completes.
    db.exec(`
      DROP TABLE IF EXISTS events_vec;
      CREATE VIRTUAL TABLE events_vec USING vec0(embedding float[3072]);
    `);
  },
};
