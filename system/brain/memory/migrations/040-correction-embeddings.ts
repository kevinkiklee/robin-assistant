import type { Migration } from './types.ts';

/**
 * Embeddings for the `corrections` table, so auto-recall can inject the 1–3
 * corrections relevant to the current prompt (the primer's 5,000-char sub-cap fits
 * only ~5 of 316, and corrections were not in auto-recall's allowlist at all).
 *
 * A derived cache, never a second source of truth: `corrections` stays
 * authoritative; a row here is (re)computed whenever `text_sha` no longer matches
 * the correction's embed text, and is dropped with its correction. Kept OUT of
 * `events_vec` on purpose — corrections are few (~300), so a brute-force cosine in
 * process is ~1 ms and needs no vec0 table, and they never compete with the
 * general recall corpus. A separate table (not a column) also keeps the BLOB out
 * of every `SELECT * FROM corrections` (MCP list/audit dump whole rows).
 */
export const migration040: Migration = {
  version: 40,
  name: 'correction-embeddings',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS correction_embeddings (
        correction_id INTEGER PRIMARY KEY REFERENCES corrections(id) ON DELETE CASCADE,
        text_sha      TEXT NOT NULL,
        embedding     BLOB NOT NULL,
        embedded_at   TEXT NOT NULL
      );
    `);
  },
};
