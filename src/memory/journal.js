import { BoundQuery } from 'surrealdb';

/**
 * Journal — chronological list of significant biographed events.
 *
 * "Significant" is content-driven: corrections always surface, plus any event
 * with content length >= `minContentLen`. Filters require `biographed_at` to
 * be set (i.e. the biographer has processed the event into the entity graph).
 *
 * `minContentLen` is interpolated as a literal integer because SurrealDB's
 * `string::len(...) >= $param` comparison is fine with bindings, but we
 * follow the recall.js precedent of validating numeric clauses up-front
 * rather than trusting whatever the caller passes through.
 */
export async function listJournalEntries(
  db,
  { since, until, limit = 50, minContentLen = 50 } = {},
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error(`listJournalEntries: limit out of range [1,1000]: ${limit}`);
  }
  if (!Number.isInteger(minContentLen) || minContentLen < 0 || minContentLen > 100000) {
    throw new Error(`listJournalEntries: minContentLen out of range [0,100000]: ${minContentLen}`);
  }

  const filters = [
    'biographed_at IS NOT NONE',
    `(meta.kind = 'correction' OR string::len(content) >= ${minContentLen})`,
  ];
  const bindings = {};
  if (since != null) {
    bindings.since = new Date(since);
    filters.push('ts >= $since');
  }
  if (until != null) {
    bindings.until = new Date(until);
    filters.push('ts <= $until');
  }

  const sql = `
    SELECT id, source, content, ts, episode_id, meta
    FROM events
    WHERE ${filters.join(' AND ')}
    ORDER BY ts DESC
    LIMIT ${limit}
  `;
  const [rows] = await db.query(new BoundQuery(sql, bindings)).collect();
  return rows;
}
