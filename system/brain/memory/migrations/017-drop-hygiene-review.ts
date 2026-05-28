import type { Migration } from './types.ts';

// 2026-05-28: hygiene review surfaced to the user via the brief's Data Hygiene
// section. Kevin pulled the user-facing review entirely — the nightly dream
// pass now auto-culls Tier 2 candidates inline (system/brain/cognition/hygiene.ts).
// Dropping the table prevents any future code from re-wiring a human-in-the-loop
// triage step. The companion noise_blocklist stays — Tier 1 still uses it.
export const migration017: Migration = {
  version: 17,
  name: 'drop-hygiene-review',
  up: (db) => {
    db.exec(`
      DROP INDEX IF EXISTS hygiene_review_pending;
      DROP TABLE IF EXISTS hygiene_review;
    `);
  },
};
