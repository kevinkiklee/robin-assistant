import type { Migration } from './types.ts';

export const migration024: Migration = {
  version: 24,
  name: 'alerts',
  up: (db) => {
    db.exec(`
      CREATE TABLE alerts (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        severity      TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
        source        TEXT NOT NULL,
        key           TEXT NOT NULL,
        message       TEXT NOT NULL,
        context_json  TEXT,
        first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
        fire_count    INTEGER NOT NULL DEFAULT 1,
        resolved_at   TEXT,
        acked_at      TEXT
      );
      CREATE UNIQUE INDEX alerts_open_unique
        ON alerts (source, key) WHERE resolved_at IS NULL;
      CREATE INDEX alerts_resolved_idx ON alerts (resolved_at);
    `);
  },
};
