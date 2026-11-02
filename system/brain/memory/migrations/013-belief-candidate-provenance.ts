import type { Migration } from './types.ts';

/**
 * Add a `provenance` class column to belief candidates. The biographer tags
 * each candidate (P3) so the promotion gate can route by class — external
 * readings never promote, weak classes need higher confidence. Nullable for
 * back-compat with candidates inserted before this migration.
 */
export const migration013: Migration = {
  version: 13,
  name: 'belief-candidate-provenance',
  up: (db) => {
    db.exec(`ALTER TABLE belief_candidates ADD COLUMN provenance TEXT;`);
  },
};
