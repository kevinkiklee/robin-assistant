import type { Migration } from './types.ts';

/**
 * Per-instance entity-alias map: collapse known name variants to one canonical
 * entity (and type) at upsert time — e.g. "Kevin K Lee" / "Kevin K. Lee" /
 * "Kevin" → "Kevin Lee" (person). The case-insensitive dedup in upsertEntity
 * only catches case/whitespace variants, and the LLM disambiguation is flaky on
 * middle-initial / name-subset forms, so well-known entities (especially the
 * owner) kept re-forking into duplicates that needed manual merges.
 *
 * Ships EMPTY: alias rows are user-specific and seeded per instance (mirrors
 * noise_blocklist), so the package carries the mechanism, never the data.
 * `alias` is the lowercased lookup key (PRIMARY KEY → its own index).
 * `canonical_type` is optional — when set it forces the canonical type, so an
 * extraction mis-typed as `thing` still resolves to the real `person`.
 */
export const migration028: Migration = {
  version: 28,
  name: 'entity-aliases',
  up: (db) => {
    db.exec(`
      CREATE TABLE entity_aliases (
        alias          TEXT PRIMARY KEY,
        canonical_name TEXT NOT NULL,
        canonical_type TEXT,
        source         TEXT NOT NULL DEFAULT 'manual',
        added_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  },
};
