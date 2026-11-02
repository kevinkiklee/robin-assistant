import type { Migration } from './types.ts';

export const migration002: Migration = {
  version: 2,
  name: 'entities-relations',
  up: (db) => {
    db.exec(`
      CREATE TABLE entities (
        id          INTEGER PRIMARY KEY,
        type        TEXT NOT NULL,
        canonical_name TEXT NOT NULL,
        profile     TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (type, canonical_name)
      );
      CREATE INDEX entities_type_name ON entities(type, canonical_name);

      CREATE TABLE relations (
        id              INTEGER PRIMARY KEY,
        subject_id      INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        predicate       TEXT NOT NULL,
        object_id       INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        ts              TEXT NOT NULL,
        source_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL
      );
      CREATE INDEX relations_subject ON relations(subject_id, predicate);
      CREATE INDEX relations_object ON relations(object_id, predicate);

      CREATE TABLE recall_log (
        id             INTEGER PRIMARY KEY,
        ts             TEXT NOT NULL,
        query_hash     TEXT NOT NULL,
        result_count   INTEGER NOT NULL,
        outcome        TEXT NOT NULL DEFAULT 'pending',
        outcome_at     TEXT
      );
      CREATE INDEX recall_log_outcome ON recall_log(outcome, ts);

      CREATE TABLE embedding_profiles (
        name       TEXT PRIMARY KEY,
        dim        INTEGER NOT NULL,
        model      TEXT NOT NULL,
        active     INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE VIRTUAL TABLE events_vec USING vec0(embedding float[1024]);
    `);
  },
};
