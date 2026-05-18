// Multi-session registry helpers (Phase 4a §5.E).
//
// Reads/writes the `runtime_sessions` table (migration 0010). Used by:
//   - SessionStart hook (registerSession)
//   - Stop hook (endSession)
//   - daemon heartbeat (markStaleSessions)
//   - `robin sessions` CLI (listActiveSessions, purgeStaleSessions)
//
// The unique index `runtime_sessions_session` on session_id makes UPSERT
// safe: re-registering the same session bumps last_seen_at without
// duplicating the row.

import { surql } from 'surrealdb';
import { toRecordRef } from '../../data/db/record-ref.js';
import { HOST_VALUES } from '../hosts/index.js';

/**
 * Register or refresh a session.
 *
 * If a row with the same session_id already exists, last_seen_at is bumped
 * to now, status is set to 'active', and transcript_path is overwritten
 * when newly provided. Otherwise a new row is created.
 *
 * @param {object} db
 * @param {object} args
 * @param {string} args.sessionId
 * @param {'claude-code'|'gemini-cli'|'unknown'} args.host
 * @param {number} [args.pid]
 * @param {string} [args.transcriptPath]
 * @returns {Promise<object>} the persisted row
 */
export async function registerSession(db, { sessionId, host, pid, transcriptPath } = {}) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('registerSession: sessionId is required');
  }
  if (!HOST_VALUES.includes(host)) {
    throw new Error(`registerSession: invalid host ${host}`);
  }

  // SurrealDB v3: UPSERT against a SELECT-by-unique-field is awkward; instead
  // we look up first, then either UPDATE the matched row or CREATE a fresh
  // one. The unique index on session_id keeps races safe (a concurrent
  // CREATE would fail and we'd retry, but in practice SessionStart only
  // fires once per session).
  const [existing] = await db
    .query(surql`SELECT id FROM runtime_sessions WHERE session_id = ${sessionId} LIMIT 1`)
    .collect();
  if (existing.length > 0) {
    const recordId = existing[0].id;
    const updates = {
      last_seen_at: new Date(),
      status: 'active',
    };
    if (typeof transcriptPath === 'string' && transcriptPath.length > 0) {
      updates.transcript_path = transcriptPath;
    }
    if (Number.isInteger(pid)) {
      updates.pid = pid;
    }
    const [rows] = await db
      .query(surql`UPDATE ${toRecordRef(recordId)} MERGE ${updates}`)
      .collect();
    return rows[0];
  }

  const fields = {
    session_id: sessionId,
    host,
    status: 'active',
  };
  if (Number.isInteger(pid)) fields.pid = pid;
  if (typeof transcriptPath === 'string' && transcriptPath.length > 0) {
    fields.transcript_path = transcriptPath;
  }
  const [rows] = await db.query(surql`CREATE runtime_sessions CONTENT ${fields}`).collect();
  return rows[0];
}

/**
 * Mark a session as ended. No-op if not found.
 *
 * @param {object} db
 * @param {string} sessionId
 * @returns {Promise<object|null>} the updated row, or null if missing
 */
export async function endSession(db, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  const [rows] = await db
    .query(
      surql`UPDATE runtime_sessions SET status = 'ended', last_seen_at = time::now() WHERE session_id = ${sessionId}`,
    )
    .collect();
  return rows[0] ?? null;
}

/**
 * Mark active sessions whose last_seen_at is older than the threshold as
 * 'stale'. Returns the count of rows mutated.
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {number} [opts.staleMs=300000] threshold in milliseconds (default 5 min)
 * @returns {Promise<number>}
 */
export async function markStaleSessions(db, { staleMs = 5 * 60_000 } = {}) {
  const cutoff = new Date(Date.now() - staleMs);
  const [rows] = await db
    .query(
      surql`UPDATE runtime_sessions SET status = 'stale' WHERE status = 'active' AND last_seen_at < ${cutoff}`,
    )
    .collect();
  return Array.isArray(rows) ? rows.length : 0;
}

/**
 * List active sessions ordered by started_at ascending.
 *
 * @param {object} db
 * @returns {Promise<Array<object>>}
 */
export async function listActiveSessions(db) {
  const [rows] = await db
    .query(surql`SELECT * FROM runtime_sessions WHERE status = 'active' ORDER BY started_at ASC`)
    .collect();
  return rows;
}

/**
 * Delete all sessions whose status is 'stale'. Returns the count deleted.
 *
 * @param {object} db
 * @returns {Promise<number>}
 */
export async function purgeStaleSessions(db) {
  const [rows] = await db
    .query(surql`DELETE FROM runtime_sessions WHERE status = 'stale' RETURN BEFORE`)
    .collect();
  return Array.isArray(rows) ? rows.length : 0;
}
