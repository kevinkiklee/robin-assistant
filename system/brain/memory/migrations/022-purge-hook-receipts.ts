import type { Migration } from './types.ts';

export const migration022: Migration = {
  version: 22,
  name: 'purge-hook-receipt-events',
  up: (db) => {
    // Every 'invariant.check' event was a hook receipt written by daemon.onHook (the
    // write is now removed). 27k mislabeled operational acks with no content/vectors
    // attached; nothing reads them. Purge. VACUUM (run post-migration) reclaims pages.
    db.exec(`DELETE FROM events WHERE kind = 'invariant.check'`);
  },
};
