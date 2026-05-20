import type { Migration } from './types.ts';

export const migration005: Migration = {
  version: 5,
  name: 'events-vec-4096',
  up: (db) => {
    // qwen3-embedding:8b outputs 4096-dim native (Matryoshka-trained, so truncation is
    // possible at read time but native is best quality). Drop + recreate is safe because
    // events_vec was empty under the prior 1024-dim schema — no embedder was wired.
    //
    // If this ever needs to run against a non-empty events_vec, the right answer is a
    // fresh reindex pass, not a vector projection: 1024-dim vectors from a different
    // embedder are not semantically comparable to 4096-dim qwen3 vectors.
    db.exec(`
      DROP TABLE events_vec;
      CREATE VIRTUAL TABLE events_vec USING vec0(embedding float[4096]);
    `);
  },
};
