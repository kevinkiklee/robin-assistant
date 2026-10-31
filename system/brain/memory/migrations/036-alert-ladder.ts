import type { Migration } from './types.ts';

/**
 * Incident ladder state (reliability spec section B). One repair attempt and
 * one escalation per incident, recorded ON the incident row so daemon restarts
 * cannot double-fire — the row is the dedup, same discipline as the shutdown
 * stamp. `outcome`: 'repaired' | 'needs-human' | NULL (still in flight).
 */
export const migration036: Migration = {
  version: 36,
  name: 'alert-ladder',
  up: (db) => {
    db.exec(`ALTER TABLE alerts ADD COLUMN repair_attempted_at TEXT;`);
    db.exec(`ALTER TABLE alerts ADD COLUMN escalated_at TEXT;`);
    db.exec(`ALTER TABLE alerts ADD COLUMN outcome TEXT;`);
  },
};
