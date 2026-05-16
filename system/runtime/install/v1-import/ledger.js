// ledger.js — read helpers for the _v1_imports table.
//
// Writers insert ledger rows inline via `tx.js`; passes use `hashExists` and
// `findByPath` to dedupe and to discover superseded targets.

import { BoundQuery } from 'surrealdb';

/**
 * Does any ledger row carry this content hash?
 */
export async function hashExists(db, hash) {
  const [rows] = await db
    .query(
      new BoundQuery('SELECT VALUE id FROM _v1_imports WHERE content_hash = $h LIMIT 1', {
        h: hash,
      }),
    )
    .collect();
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * Return the ledger row for a specific content hash, or null if absent.
 * Used by writers to recover the existing target record id on idempotent
 * re-runs (when `hashExists` is true and the caller still needs the id to
 * build edges).
 */
export async function findByHash(db, hash) {
  const [rows] = await db
    .query(
      new BoundQuery(
        'SELECT content_hash, target, kind, imported_at FROM _v1_imports WHERE content_hash = $h ORDER BY imported_at DESC LIMIT 1',
        { h: hash },
      ),
    )
    .collect();
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return { hash: rows[0].content_hash, target: rows[0].target, kind: rows[0].kind };
}

/**
 * Find the most recent ledger row for a source path. Used for supersedes-on-edit
 * and (via the optional `kind` filter) by passes that resolve to a specific
 * import-shape.
 *
 * A single source file can produce *multiple* ledger rows of different kinds —
 * e.g. profile/interests.md emits both a `memo` (the body) and a
 * `persona_field` (facets extracted into the persona singleton). Callers that
 * want the memo specifically must pass `{ kind: 'memo' }`; otherwise the
 * persona_field row may shadow it (whichever was written last wins the
 * `ORDER BY imported_at DESC LIMIT 1`), leaving the caller staring at a
 * non-memo target and falling through to its unresolved branch.
 *
 * Returns null if no prior import matching the (optional) kind exists.
 */
export async function findByPath(db, sourcePath, { kind } = {}) {
  const where = kind ? 'WHERE source_path = $p AND kind = $k' : 'WHERE source_path = $p';
  const params = kind ? { p: sourcePath, k: kind } : { p: sourcePath };
  const [rows] = await db
    .query(
      new BoundQuery(
        `SELECT content_hash, target, kind, imported_at FROM _v1_imports ${where} ORDER BY imported_at DESC LIMIT 1`,
        params,
      ),
    )
    .collect();
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return { hash: rows[0].content_hash, target: rows[0].target, kind: rows[0].kind };
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
      new BoundQuery('SELECT target, kind FROM _v1_imports WHERE import_session = $s', {
        s: sessionId,
      }),
    )
    .collect();
  const counts = {};
  for (const row of rows ?? []) {
    counts[row.kind] = (counts[row.kind] ?? 0) + 1;
    if (row.kind === 'source_file') continue; // filesystem path, not a record
    if (row.kind === 'persona_field') continue; // singleton; structured fields stay
    // Split "table:id" into table + id for type::record(string, string).
    const idx = String(row.target).indexOf(':');
    if (idx < 1) continue;
    const tb = row.target.slice(0, idx);
    const key = row.target.slice(idx + 1);
    await db.query(new BoundQuery('DELETE type::record($tb, $k)', { tb, k: key })).collect();
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
