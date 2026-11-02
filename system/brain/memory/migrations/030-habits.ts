import type { Migration } from './types.ts';

/**
 * Behavioral Habit Inference (Phase 2). A `habits` table — a DISTINCT soft store,
 * structurally separate from `belief_candidates` (which stays the *facts* review
 * queue). Habits are hedged, hint-grade generalizations over many behavioral signals
 * ("tends to buy gear before a planned trip"); keeping them in their own table is the
 * guard that Robin can never render a soft tendency as a stated fact.
 *
 * Design ref: docs/design/2026-06-17-behavioral-habit-inference-design.md §4.
 *
 * Notable columns:
 *  - `evidence_summary` is a TEXT snapshot of the supporting signals at inference
 *    time. Robin purges events aggressively (the self-capture cleanup deleted ~9k),
 *    and a JSON id-array in `evidence_event_ids` cannot `ON DELETE SET NULL`, so the
 *    text snapshot is the durable audit trail that survives source-event purges.
 *  - `embedding` (nullable BLOB) backs semantic dedup/upsert and retired-suppression
 *    matching; same Float32Array-as-blob idiom as belief_candidates.embedding.
 *  - `graduated_belief_id` FK → the `preferences` belief_candidate spawned on
 *    graduation, `ON DELETE SET NULL` so deleting the candidate never orphans-FK the
 *    habit row.
 */
export const migration030: Migration = {
  version: 30,
  name: 'habits',
  up: (db) => {
    db.exec(`
      CREATE TABLE habits (
        id                  INTEGER PRIMARY KEY,
        statement           TEXT NOT NULL,
        domain              TEXT NOT NULL,
        pattern_kind        TEXT NOT NULL,  -- purchase | temporal | preference | workflow | consumption
        confidence          REAL NOT NULL DEFAULT 0,  -- 0..1, soft; engine-owned (§6)
        support_count       INTEGER NOT NULL DEFAULT 0,
        support_streams     INTEGER NOT NULL DEFAULT 0,
        contradiction_count INTEGER NOT NULL DEFAULT 0,
        evidence_event_ids  TEXT NOT NULL DEFAULT '[]',  -- JSON array of source event ids (may dangle after purges)
        evidence_summary    TEXT NOT NULL DEFAULT '',     -- durable text snapshot of supporting signals
        embedding           BLOB,                          -- nullable; for dedup + retired-suppression matching
        first_seen          TEXT NOT NULL,
        last_seen           TEXT NOT NULL,
        last_reinforced     TEXT NOT NULL,                 -- drives the confidence recency term
        status              TEXT NOT NULL DEFAULT 'soft',  -- soft | graduated | retired
        graduated_belief_id INTEGER REFERENCES belief_candidates(id) ON DELETE SET NULL,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.exec(`CREATE INDEX habits_status ON habits(status, last_reinforced);`);
    db.exec(`CREATE INDEX habits_domain ON habits(domain);`);
    db.exec(`CREATE INDEX habits_last_reinforced ON habits(last_reinforced);`);
  },
};
