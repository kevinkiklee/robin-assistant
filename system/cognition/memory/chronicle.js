// chronicle.js — chronological list of significant biographed events.
//
// Lists biographed events whose content is long enough OR whose meta.kind
// is 'correction'. Exposed to the user as `robin journal` (CLI) and
// `list_journal` (MCP tool); the file kept its older "chronicle" name from
// the v1→v2 rename for grep stability but the function name follows the
// user-facing surface.

import { BoundQuery } from 'surrealdb';

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
