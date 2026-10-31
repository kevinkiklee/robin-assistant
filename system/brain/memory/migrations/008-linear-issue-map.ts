import type { Migration } from './types.ts';

export const migration008: Migration = {
  version: 8,
  name: 'linear-issue-map',
  up: (db) => {
    db.exec(`
      CREATE TABLE linear_issue_map (
        robin_ref        TEXT PRIMARY KEY,
        linear_issue_id  TEXT NOT NULL,
        identifier       TEXT,
        team_id          TEXT,
        last_state_type  TEXT,
        commented_refs   TEXT NOT NULL DEFAULT '[]',
        source_event_id  INTEGER,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        last_action_at   TEXT NOT NULL DEFAULT (datetime('now')),
        last_action      TEXT
      );
    `);
    db.exec(`CREATE INDEX idx_lim_issue ON linear_issue_map(linear_issue_id);`);
  },
};
