import { surql } from 'surrealdb';

/**
 * Count un-biographed events. Used by health checks and the dispatcher's
 * overflow fallback.
 */
export async function countPendingEvents(db) {
  const [rows] = await db
    .query(surql`SELECT count() AS n FROM events WHERE biographed_at IS NONE GROUP ALL`)
    .collect();
  return rows[0]?.n ?? 0;
}

/**
 * List un-biographed event ids, oldest first.
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {Date|string} [opts.since] — only events with ts >= this
 * @param {number} [opts.limit=50]
 * @returns {Promise<Array<{id: any, ts: any}>>}
 */
export async function listPendingEvents(db, { since, limit = 50 } = {}) {
  const q = since
    ? surql`SELECT id, ts FROM events WHERE biographed_at IS NONE AND ts >= ${since} ORDER BY ts ASC LIMIT ${limit}`
    : surql`SELECT id, ts FROM events WHERE biographed_at IS NONE ORDER BY ts ASC LIMIT ${limit}`;
  const [rows] = await db.query(q).collect();
  return rows ?? [];
}
