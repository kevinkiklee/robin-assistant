import type { Migration } from './types.ts';

/**
 * Phase C (§C4): track when an entity profile was synthesized so read surfaces
 * can refuse to serve stale text as current truth. Backfill: profiled rows get
 * the migration date (profiles were re-synthesized 2026-06-10, so this is
 * accurate in practice); unprofiled rows stay NULL.
 */
export const migration027: Migration = {
  version: 27,
  name: 'profile-generated-at',
  up: (db) => {
    db.exec(`ALTER TABLE entities ADD COLUMN profile_generated_at TEXT;`);
    db.exec(
      `UPDATE entities SET profile_generated_at = datetime('now') WHERE profile IS NOT NULL;`,
    );
  },
};
