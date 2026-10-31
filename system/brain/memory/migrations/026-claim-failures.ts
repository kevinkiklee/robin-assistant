import type { Migration } from './types.ts';

/**
 * Phase C (§C3): dead-letter queue for biographer claim extraction. A chunk
 * whose claim pass timed out or failed validation lands here VERBATIM
 * (chunk_body) so retries never depend on the chunker reproducing identical
 * boundaries across code changes. attempts counts extraction tries (initial
 * failure = 1); rows with attempts >= 3 are exhausted audit records, pruned
 * after 30 days by the retry pass.
 */
export const migration026: Migration = {
  version: 26,
  name: 'claim-failures',
  up: (db) => {
    db.exec(`CREATE TABLE claim_failures (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id   INTEGER NOT NULL,
      chunk_idx  INTEGER NOT NULL,
      chunk_body TEXT NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 1,
      last_error TEXT,
      ts         TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (event_id, chunk_idx)
    );`);
    db.exec(`CREATE INDEX claim_failures_attempts ON claim_failures(attempts, ts);`);
  },
};
