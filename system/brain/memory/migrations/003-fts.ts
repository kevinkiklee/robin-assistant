import type { Migration } from './types.ts';

export const migration003: Migration = {
  version: 3,
  name: 'fts-events-content',
  up: (db) => {
    db.exec(`
      CREATE VIRTUAL TABLE events_content_fts USING fts5(body, content='events_content', content_rowid='id');
      CREATE TRIGGER events_content_ai AFTER INSERT ON events_content BEGIN
        INSERT INTO events_content_fts(rowid, body) VALUES (new.id, new.body);
      END;
      CREATE TRIGGER events_content_ad AFTER DELETE ON events_content BEGIN
        INSERT INTO events_content_fts(events_content_fts, rowid, body) VALUES('delete', old.id, old.body);
      END;
      CREATE TRIGGER events_content_au AFTER UPDATE ON events_content BEGIN
        INSERT INTO events_content_fts(events_content_fts, rowid, body) VALUES('delete', old.id, old.body);
        INSERT INTO events_content_fts(rowid, body) VALUES (new.id, new.body);
      END;
    `);
  },
};
