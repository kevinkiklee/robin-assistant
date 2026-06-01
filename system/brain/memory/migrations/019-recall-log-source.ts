import type { Migration } from './types.ts';

export const migration019: Migration = {
  version: 19,
  name: 'recall-log-source',
  up: (db) => {
    // recall_log (migration 002) had no way to tell apart manual/MCP recall queries
    // from the deterministic per-turn auto-recall hot path. Tagging the source lets
    // "are we recalling junk?" aggregation be answered per-source. Additive column
    // with a default so existing rows and old INSERTs (none remain) stay valid.
    db.exec(`ALTER TABLE recall_log ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';`);
  },
};
