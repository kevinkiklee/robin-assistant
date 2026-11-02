import type { Migration } from './types.ts';

export const migration012: Migration = {
  version: 12,
  name: 'import-dedup-keys',
  up: (db) => {
    // Idempotent v2 re-import: `robin import` previously plain-INSERTed events and
    // edges, so re-running it on the same dump duplicated every row. A stable
    // `import_key` (the v2 record id, else a content hash) + a unique partial
    // index lets the importer use INSERT OR IGNORE — a second run becomes a no-op.
    // Partial (WHERE import_key IS NOT NULL) so it never constrains rows created
    // by the live runtime (capture, biographer, integrations), which don't set it.
    db.exec(`ALTER TABLE events ADD COLUMN import_key TEXT;`);
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS events_import_key
       ON events(import_key) WHERE import_key IS NOT NULL;`,
    );

    db.exec(`ALTER TABLE relations ADD COLUMN import_key TEXT;`);
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS relations_import_key
       ON relations(import_key) WHERE import_key IS NOT NULL;`,
    );
  },
};
