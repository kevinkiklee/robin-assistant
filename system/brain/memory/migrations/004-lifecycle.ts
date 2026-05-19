import type { Migration } from './types.ts';

export const migration004: Migration = {
  version: 4,
  name: 'lifecycle-tables',
  up: (db) => {
    db.exec(`
      CREATE TABLE predictions (
        id                INTEGER PRIMARY KEY,
        claim             TEXT NOT NULL,
        confidence        REAL NOT NULL,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        deadline          TEXT,
        resolution_method TEXT,
        outcome           TEXT,
        resolved_at       TEXT,
        evidence          TEXT,
        brier_delta       REAL
      );
      CREATE INDEX predictions_deadline ON predictions(deadline, outcome);

      CREATE TABLE corrections (
        id          INTEGER PRIMARY KEY,
        ts          TEXT NOT NULL DEFAULT (datetime('now')),
        what        TEXT NOT NULL,
        correction  TEXT NOT NULL,
        context     TEXT,
        applied     INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX corrections_ts ON corrections(ts);

      CREATE TABLE refusals (
        id        INTEGER PRIMARY KEY,
        ts        TEXT NOT NULL DEFAULT (datetime('now')),
        request   TEXT NOT NULL,
        reason    TEXT NOT NULL,
        action_policy TEXT
      );
      CREATE INDEX refusals_ts ON refusals(ts);

      CREATE TABLE audit_meta (
        id            INTEGER PRIMARY KEY,
        ts            TEXT NOT NULL DEFAULT (datetime('now')),
        actor         TEXT NOT NULL,
        query         TEXT NOT NULL,
        rows_returned INTEGER,
        scope         TEXT
      );

      CREATE TABLE metrics_daily (
        day         TEXT NOT NULL,
        metric      TEXT NOT NULL,
        value       REAL NOT NULL,
        n           INTEGER NOT NULL,
        computed_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (day, metric)
      );

      CREATE TABLE journals (
        day         TEXT PRIMARY KEY,
        body        TEXT NOT NULL,
        generated_at TEXT NOT NULL DEFAULT (datetime('now')),
        content_ref INTEGER REFERENCES events_content(id) ON DELETE SET NULL
      );
    `);
  },
};
