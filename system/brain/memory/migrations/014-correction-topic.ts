import type { Migration } from './types.ts';

/**
 * Add a `topic` column to the corrections table so a correction can be linked
 * to a specific belief topic. When present, `applyCorrections` uses this link
 * to automatically retract the contradicted belief head during the nightly
 * dream pass (P4 replay). NULL means the correction is a behavioral/global
 * rule not tied to a specific belief; those are left untouched by replay.
 */
export const migration014: Migration = {
  version: 14,
  name: 'correction-topic',
  up: (db) => {
    db.exec(`ALTER TABLE corrections ADD COLUMN topic TEXT;`);
  },
};
