import type { Migration } from './types.ts';

export const migration007: Migration = {
  version: 7,
  name: 'predictions-external-id',
  up: (db) => {
    db.exec(`ALTER TABLE predictions ADD COLUMN external_id TEXT;`);
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS predictions_external_id
       ON predictions(external_id) WHERE external_id IS NOT NULL;`,
    );
  },
};
