import type { Migration } from './types.ts';

/**
 * Phase D: personal-domain tag for memory items. The biographer tags each
 * belief candidate and entity with a PERSONAL_DOMAINS value at extraction; the
 * promotion gate rejects an explicit non-personal domain. Nullable for back-compat
 * — pre-Phase-D rows stay NULL and are grandfathered as promotable.
 */
export const migration029: Migration = {
  version: 29,
  name: 'memory-domain',
  up: (db) => {
    db.exec(`ALTER TABLE belief_candidates ADD COLUMN domain TEXT;`);
    db.exec(`ALTER TABLE entities ADD COLUMN domain TEXT;`);
  },
};
