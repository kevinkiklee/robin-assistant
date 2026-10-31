import { normalizeEntityName } from '../normalize.ts';
import type { Migration } from './types.ts';

/**
 * Re-backfill entities.normalized_name after the normalizer learned to preserve
 * '+': the 033 backfill folded "Apple TV+" (service) and "Apple TV" (product)
 * into one key, which would merge two real entities on the next upsert of
 * either. Idempotent — rows already matching the current rule are untouched.
 * This is the documented protocol for evolving normalizeEntityName: never edit
 * an applied migration; re-run the backfill in a new one.
 */
export const migration034: Migration = {
  version: 34,
  name: 'normalized-name-rebackfill',
  up: (db) => {
    const rows = db
      .prepare(`SELECT id, canonical_name, normalized_name FROM entities`)
      .all() as Array<{ id: number; canonical_name: string; normalized_name: string | null }>;
    const setNorm = db.prepare(`UPDATE entities SET normalized_name = ? WHERE id = ?`);
    for (const r of rows) {
      const key = normalizeEntityName(r.canonical_name);
      if (key !== r.normalized_name) setNorm.run(key, r.id);
    }
  },
};
