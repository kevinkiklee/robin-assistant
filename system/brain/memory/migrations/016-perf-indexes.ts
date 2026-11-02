import type { Migration } from './types.ts';

export const migration016: Migration = {
  version: 16,
  name: 'perf-indexes',
  up: (db) => {
    // Ingest dedup hot path. `system/brain/memory/ingest.ts` upserts events by
    // `(source, json_extract(payload,'$.external_id'))` on every integration
    // tick. Without an index the WHERE clause is an O(n) table scan that grows
    // with every event ingested; on a multi-thousand-row backlog a single tick
    // can re-scan the table dozens of times. The partial WHERE keeps the index
    // small — only events that actually carry an external_id participate.
    db.exec(
      `CREATE INDEX IF NOT EXISTS events_source_external_id
       ON events(source, json_extract(payload, '$.external_id'))
       WHERE json_extract(payload, '$.external_id') IS NOT NULL;`,
    );

    // Belief-candidate dedup hot path. `system/brain/memory/belief-candidate.ts`
    // checks `WHERE status='pending' AND topic=? AND claim=?` on every insert
    // to avoid duplicate pending candidates. The existing
    // `belief_candidates_status` index `(status, created_at)` doesn't help that
    // probe. Partial WHERE focuses the index on the live pending set — once a
    // candidate is promoted/rejected it leaves the index and stops costing.
    db.exec(
      `CREATE INDEX IF NOT EXISTS belief_candidates_pending_topic_claim
       ON belief_candidates(topic, claim)
       WHERE status = 'pending';`,
    );
  },
};
