// chronicle.js — chronological list of significant biographed events.
// Spec §5 / module-rename from journal.js. Same filtering: biographed events,
// content length ≥ minContentLen OR meta.kind = 'correction'.
//
// Backward-compat note: a `listJournalEntries` alias is exported at the bottom
// of this file because several call sites (CLI `robin journal`, MCP tool
// `list_journal`) still use the old name. Remove once those migrate.

import { BoundQuery } from 'surrealdb';

export async function listChronicleEntries(
  db,
  { since, until, limit = 50, minContentLen = 50 } = {},
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error(`listChronicleEntries: limit out of range [1,1000]: ${limit}`);
  }
  if (!Number.isInteger(minContentLen) || minContentLen < 0 || minContentLen > 100000) {
    throw new Error(
      `listChronicleEntries: minContentLen out of range [0,100000]: ${minContentLen}`,
    );
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

// Legacy alias for backward compatibility during migration.
export const listJournalEntries = listChronicleEntries;
