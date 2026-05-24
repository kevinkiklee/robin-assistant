import type { Migration } from './types.ts';

export const migration009: Migration = {
  version: 9,
  name: 'belief-candidates',
  up: (db) => {
    db.exec(`
      CREATE TABLE belief_candidates (
        id              INTEGER PRIMARY KEY,
        topic           TEXT NOT NULL,
        claim           TEXT NOT NULL,
        confidence      REAL,
        source_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
        status          TEXT NOT NULL DEFAULT 'pending',  -- pending | promoted | rejected
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at     TEXT
      );
    `);
    db.exec(`CREATE INDEX belief_candidates_status ON belief_candidates(status, created_at);`);
  },
};
