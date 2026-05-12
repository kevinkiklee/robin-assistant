// ledger.js — read/write helpers for the _v1_imports table.
//
// Writers call `recordImport` inside their transactional block; passes use
// `hashExists` and `findByPath` to dedupe and to discover superseded targets.

import { BoundQuery } from 'surrealdb';

/**
 * Does any ledger row carry this content hash?
 */
export async function hashExists(db, hash) {
  const [rows] = await db
    .query(new BoundQuery('SELECT VALUE id FROM _v1_imports WHERE content_hash = $h LIMIT 1', { h: hash }))
    .collect();
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * Find the most recent ledger row for a source path. Used for supersedes-on-edit.
 * Returns null if no prior import for the path.
 */
export async function findByPath(db, sourcePath) {
  const [rows] = await db
    .query(
      new BoundQuery(
        'SELECT content_hash, target, kind, imported_at FROM _v1_imports WHERE source_path = $p ORDER BY imported_at DESC LIMIT 1',
        { p: sourcePath },
      ),
    )
    .collect();
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return { hash: rows[0].content_hash, target: rows[0].target, kind: rows[0].kind };
}

/**
 * Insert one ledger row. Caller must be inside a transaction. `target` is a
 * stringified record ID like `"memos:abc123"`.
 */
export async function recordImport(db, { sourcePath, hash, target, kind, sessionId }) {
  await db
    .query(
      new BoundQuery(
        'CREATE _v1_imports SET source_path = $sp, content_hash = $h, target = $t, kind = $k, import_session = $s',
        { sp: sourcePath, h: hash, t: target, k: kind, s: sessionId },
      ),
    )
    .collect();
}

/**
 * Count ledger rows for a session, grouped by kind. Used by the report.
 */
export async function summary(db, sessionId) {
  const [rows] = await db
    .query(
      new BoundQuery(
        'SELECT kind, count() AS n FROM _v1_imports WHERE import_session = $s GROUP BY kind',
        { s: sessionId },
      ),
    )
    .collect();
  const out = {};
  for (const row of rows ?? []) out[row.kind] = row.n;
  return out;
}

/**
 * Delete every row imported in this session AND its target records.
 * Returns counts deleted, grouped by kind.
 *
 * Cascade behavior:
 *   - The v2 schema defines DELETE-cascade event triggers on events/entities/memos/episodes
 *     that wipe associated edges. So deleting source-of-edges records removes the
 *     edges in the same transaction.
 *   - Edges themselves can also appear in the ledger (when LINKS.md created
 *     them); we delete those edge records explicitly.
 */
export async function deleteSession(db, sessionId) {
  const [rows] = await db
    .query(
      new BoundQuery(
        'SELECT target, kind FROM _v1_imports WHERE import_session = $s',
        { s: sessionId },
      ),
    )
    .collect();
  const counts = {};
  for (const row of rows ?? []) {
    counts[row.kind] = (counts[row.kind] ?? 0) + 1;
    if (row.kind === 'source_file') continue; // filesystem path, not a record
    if (row.kind === 'persona_field') continue; // we don't unset persona singleton fields
    // DELETE by composite-id record reference
    await db.query(new BoundQuery('DELETE type::record($t)', { t: row.target })).collect();
  }
  await db
    .query(new BoundQuery('DELETE _v1_imports WHERE import_session = $s', { s: sessionId }))
    .collect();
  return counts;
}

/**
 * Find the most recent session id (highest imported_at).
 */
export async function mostRecentSession(db) {
  const [rows] = await db
    .query(
      'SELECT import_session AS s, math::max(imported_at) AS ts FROM _v1_imports GROUP BY import_session ORDER BY ts DESC LIMIT 1',
    )
    .collect();
  return Array.isArray(rows) && rows.length > 0 ? rows[0].s : null;
}
