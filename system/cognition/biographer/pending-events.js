import { surql } from 'surrealdb';

// agent_internal events are sub-LLM scratch (disambiguator candidates,
// extraction prompts). Biographer should ignore them — their "mentions" of
// entities are tool-call artifacts, not real user references.
const SKIP_SOURCES = ['agent_internal'];

/**
 * Count un-biographed events. Used by health checks and the dispatcher's
 * overflow fallback.
 */
export async function countPendingEvents(db) {
  const [rows] = await db
    .query(
      surql`SELECT count() AS n FROM events
            WHERE biographed_at IS NONE AND source NOT IN ${SKIP_SOURCES}
            GROUP ALL`,
    )
    .collect();
  return rows[0]?.n ?? 0;
}

/**
 * List un-biographed event ids, oldest first. Includes `source` so callers
 * (the C1 batch accumulator) can bucket by source without an extra round-trip.
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {Date|string} [opts.since] — only events with ts >= this
 * @param {number} [opts.limit=50]
 * @returns {Promise<Array<{id: any, ts: any, source: string}>>}
 */
export async function listPendingEvents(db, { since, limit = 50 } = {}) {
  const q = since
    ? surql`SELECT id, ts, source FROM events
            WHERE biographed_at IS NONE AND source NOT IN ${SKIP_SOURCES} AND ts >= ${since}
            ORDER BY ts ASC LIMIT ${limit}`
    : surql`SELECT id, ts, source FROM events
            WHERE biographed_at IS NONE AND source NOT IN ${SKIP_SOURCES}
            ORDER BY ts ASC LIMIT ${limit}`;
  const [rows] = await db.query(q).collect();
  return rows ?? [];
}
