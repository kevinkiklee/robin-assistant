import type { Migration } from './types.ts';

export const migration006: Migration = {
  version: 6,
  name: 'biographer-progress',
  up: (db) => {
    // Per-session chunk-extraction progress so the biographer can process a
    // large session across multiple cron ticks instead of all-or-nothing in a
    // single tick. A row exists only while a session is mid-extraction; it is
    // deleted once the final `biographer.extracted` marker is written.
    //
    // Why this table exists: a session whose total chunk-time exceeds the
    // daemon's 30-min sustained-CRITICAL gate could never complete in one tick
    // — the daemon force-restarted mid-session and re-claimed the same row
    // forever (a restart loop, zero progress). Bounding chunks-per-tick and
    // persisting the cursor here lets any session finish over N ticks.
    db.exec(`
      CREATE TABLE biographer_progress (
        source_event_id INTEGER PRIMARY KEY,
        total_chunks    INTEGER NOT NULL,
        next_chunk      INTEGER NOT NULL DEFAULT 0,
        entities_json   TEXT NOT NULL DEFAULT '[]',
        relations_json  TEXT NOT NULL DEFAULT '[]',
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  },
};
