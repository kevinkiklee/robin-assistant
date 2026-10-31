import type { Migration } from './types.ts';

/**
 * Recommendation→Action Loop (Phase 1). A `recommendations` ledger — a first-class
 * record of substantive recommendations Robin makes, modeled on the `predictions`
 * lifecycle (migration 004). It closes the loop a motivating case exposed:
 * Robin recommended a gadget, the operator bought it, and nothing linked the two.
 *
 * Design ref: docs/design/2026-06-17-recommendation-loop-design.md §3.
 *
 * Notable columns:
 *  - `subject` is the linker's MATCH KEY — the short canonical name of the recommended
 *    thing ("Acme kettle"). The nightly `recommendation-link.run` job resolves an
 *    open recommendation when a behavioral signal's `object` canonically matches it.
 *  - `source_event_id` FK → events(id) `ON DELETE SET NULL` — where the rec was made;
 *    survives event purges by nulling rather than orphaning.
 *  - `action_event_id` FK → events(id) `ON DELETE SET NULL` — the behavioral
 *    signal/event that fulfilled it (a purchase, a decision); same purge-safety.
 *  - `evidence` is a TEXT audit of HOW the link was established; like the habits
 *    `evidence_summary`, it is the durable trail that survives the source-event purge.
 */
export const migration031: Migration = {
  version: 31,
  name: 'recommendations',
  up: (db) => {
    db.exec(`
      CREATE TABLE recommendations (
        id              INTEGER PRIMARY KEY,
        subject         TEXT NOT NULL,                 -- canonical name; the linker's match key
        claim           TEXT NOT NULL,                 -- the recommendation text/advice
        reasoning       TEXT,                          -- why Robin recommended it
        verdict         TEXT,                          -- buy | skip | wait | try | avoid | other
        domain          TEXT NOT NULL,                 -- a PERSONAL_DOMAINS bucket (calibration grouping)
        confidence      REAL NOT NULL DEFAULT 0,       -- 0..1, Robin's confidence in the rec
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        source_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,  -- where the rec was made
        expires_at      TEXT,                          -- after this an unacted rec resolves not_acted
        status          TEXT NOT NULL DEFAULT 'open',  -- open | acted | declined | expired | superseded
        outcome         TEXT,                          -- acted | not_acted | unknown (mirrors predictions)
        acted_at        TEXT,                          -- when the action was detected
        action_event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,  -- the fulfilling event
        evidence        TEXT                           -- how the link was established (durable audit)
      );
    `);
    db.exec(`CREATE INDEX recommendations_status ON recommendations(status, expires_at);`);
    db.exec(`CREATE INDEX recommendations_subject ON recommendations(subject);`);
  },
};
