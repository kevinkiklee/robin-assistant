import { normalizeEntityName } from '../normalize.ts';
import type { Migration } from './types.ts';

/**
 * Write-time dedup key for entities. The financial_account type fragmented
 * badly (one 401(k) could exist as many separate entities) because every
 * matching layer missed punctuation variants: the disambiguation candidate
 * search is a substring LIKE ("Maple Library Main Card" never matches
 * "Maple Library (Main) Card"), the alias lookup was exact-lowercase, and the
 * upsert dedup backstop was lower()-only. New duplicates were still appearing
 * — an ongoing leak, not a historical mess.
 *
 * `normalized_name` stores normalizeEntityName(canonical_name) (case,
 * punctuation, separator, and whitespace folded) and is indexed so upsertEntity
 * can match variants before insert. entity_aliases keys are re-keyed to the
 * same normalized form so alias lookups and seeds share one key space.
 */
export const migration033: Migration = {
  version: 33,
  name: 'entity-normalized-name',
  up: (db) => {
    db.exec(`ALTER TABLE entities ADD COLUMN normalized_name TEXT;`);

    const rows = db.prepare(`SELECT id, canonical_name FROM entities`).all() as Array<{
      id: number;
      canonical_name: string;
    }>;
    const setNorm = db.prepare(`UPDATE entities SET normalized_name = ? WHERE id = ?`);
    for (const r of rows) setNorm.run(normalizeEntityName(r.canonical_name), r.id);

    // Non-unique on purpose: pre-existing duplicates (the rows this migration
    // exists to expose) share a normalized key until they are merged.
    db.exec(`CREATE INDEX entities_normalized_name ON entities(normalized_name);`);

    const aliases = db.prepare(`SELECT alias FROM entity_aliases`).all() as Array<{
      alias: string;
    }>;
    const rekey = db.prepare(`UPDATE OR IGNORE entity_aliases SET alias = ? WHERE alias = ?`);
    const drop = db.prepare(`DELETE FROM entity_aliases WHERE alias = ?`);
    for (const a of aliases) {
      const key = normalizeEntityName(a.alias);
      if (key === a.alias) continue;
      rekey.run(key, a.alias);
      // If the normalized key already existed, the UPDATE was ignored — the raw
      // variant row is redundant now that lookups normalize first.
      drop.run(a.alias);
    }
  },
};
