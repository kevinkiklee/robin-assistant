import type { Migration } from './types.ts';

/**
 * Index the events → events_content link. Several queries correlate on
 * `events.content_ref` (the embedder's noise-kind exclusion, recall joins,
 * belief SELECTs), and without an index each correlated lookup scans `events`.
 * The embedder's eligibility query ran that scan once per un-embedded content
 * row — 10.9k rows × 55k events — taking 67 s of synchronous SQLite every
 * minute and leaving the daemon unresponsive most of the time (2026-10-02).
 * Partial: content-less events (most ticks) never join. The second index lets
 * the same query walk only the un-embedded rows instead of all of events_content
 * (67 s → ~10 ms on the live DB).
 */
export const migration038: Migration = {
  version: 38,
  name: 'events-content-ref-index',
  up: (db) => {
    db.exec(
      `CREATE INDEX IF NOT EXISTS events_content_ref ON events(content_ref) WHERE content_ref IS NOT NULL;
       CREATE INDEX IF NOT EXISTS events_content_unembedded ON events_content(id) WHERE embedding IS NULL;`,
    );
  },
};
