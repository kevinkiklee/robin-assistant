import type { Migration } from './types.ts';

export const migration015: Migration = {
  version: 15,
  name: 'hygiene',
  up: (db) => {
    db.exec(`
      CREATE TABLE noise_blocklist (
        id       INTEGER PRIMARY KEY,
        name     TEXT NOT NULL UNIQUE,
        reason   TEXT NOT NULL,
        source   TEXT NOT NULL DEFAULT 'hygiene',
        added_at TEXT NOT NULL
      );
      CREATE INDEX noise_blocklist_name ON noise_blocklist(name);

      CREATE TABLE hygiene_review (
        id          INTEGER PRIMARY KEY,
        entity_id   INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        entity_name TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        reason      TEXT NOT NULL,
        signals     INTEGER NOT NULL,
        flagged_at  TEXT NOT NULL,
        resolved_at TEXT,
        resolution  TEXT
      );
      CREATE INDEX hygiene_review_pending
        ON hygiene_review(resolved_at) WHERE resolved_at IS NULL;
    `);
  },
};
