import type { Migration } from './types.ts';

/**
 * recall_log records what recall() RETURNED (`injected_content_ids`), but the
 * auto-recall composer keeps only a curated subset of that pool (Layer-1 docs +
 * ≤4 allowlisted snippets) — so "what was actually injected into the turn" was
 * unmeasurable. `kept_json` lets the composer write its true kept set back onto
 * the row it just created (via recall()'s onLogged rowid callback):
 * `{ docs: [paths], snippets: [contentIds], habits: n, loops: n }`. Nullable on
 * purpose, no backfill — historical rows and non-auto sources never had a kept
 * set, and the monthly recall-audit job samples `kept_json IS NOT NULL` only.
 */
export const migration035: Migration = {
  version: 35,
  name: 'recall-kept',
  up: (db) => {
    db.exec(`ALTER TABLE recall_log ADD COLUMN kept_json TEXT;`);
  },
};
