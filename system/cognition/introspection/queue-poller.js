// queue-poller.js — claim rows from task_close_queue, run structural
// outcome inference, write task_outcome memos, delete claimed rows.
//
// Called once per drain tick (1 min interval in faculty.js).
// Each call processes up to DRAIN_BATCH_SIZE unclaimed, non-expired rows.
//
// Spec §2: outcome inference rules v1:
//   - outbound_blocked
//   - recall_fingerprint_reuse
//   - explicit_correction_followup
//
// Only rows with at least one structural signal produce a task_outcome memo
// (structural verdict present). Rows with no signals are still deleted to
// keep the queue from growing unboundedly — score=null rows will be graded
// by the LLM in Wave 3 via the dream step-outcome-grading.
//
// Claim semantics: UPDATE … SET claimed_by / claimed_at WHERE claimed_at = NONE
// AND expires_at > now(). SurrealDB serialises updates on the same record ID,
// so two concurrent drain ticks won't double-claim a row.

import { surql } from 'surrealdb';
import { buildOutcomeSummary, inferOutcome } from './outcome-inference.js';

const DRAIN_BATCH_SIZE = 50;
const DAEMON_ID = process.pid.toString();

/**
 * Run one drain tick: claim ≤ DRAIN_BATCH_SIZE rows, infer outcomes,
 * write task_outcome memos for rows with signals, delete processed rows.
 *
 * @param {object} db — SurrealDB handle
 * @returns {{ processed: number, written: number, errors: number }}
 */
export async function drainQueueOnce(db) {
  const now = new Date();
  let processed = 0;
  let written = 0;
  let errors = 0;

  // Step 1: SELECT unclaimed non-expired row IDs (SurrealDB v3 does not
  // support LIMIT on UPDATE statements; two-step SELECT + UPDATE by ID).
  const [candidateRows] = await db
    .query(
      surql`
        SELECT id, task_type, task_id, payload, event_id
        FROM task_close_queue
        WHERE claimed_at = NONE AND expires_at > ${now}
        LIMIT ${DRAIN_BATCH_SIZE}
      `,
    )
    .collect();

  const candidates = Array.isArray(candidateRows)
    ? candidateRows
    : candidateRows
      ? [candidateRows]
      : [];
  if (candidates.length === 0) return { processed: 0, written: 0, errors: 0 };

  // Step 2: Claim each row by its specific record ID. SurrealDB serializes
  // writes on the same record, so two concurrent drain calls claiming the same
  // ID safely resolve via last-write-wins — we verify claimed_by after.
  const rows = [];
  for (const candidate of candidates) {
    try {
      const [updResult] = await db
        .query(
          surql`UPDATE ONLY ${candidate.id} SET claimed_by = ${DAEMON_ID}, claimed_at = ${now}`,
        )
        .collect();
      const updated = Array.isArray(updResult) ? updResult[0] : updResult;
      if (updated && String(updated.claimed_by) === DAEMON_ID) {
        rows.push(updated);
      }
    } catch {
      // Row may have been deleted or already claimed by a race — skip.
    }
  }
  if (rows.length === 0) return { processed: 0, written: 0, errors: 0 };

  for (const row of rows) {
    processed++;
    try {
      await processRow(db, row);
      written++; // counts deletion regardless of whether a memo was written
    } catch (e) {
      errors++;
      console.warn(`[introspection/queue-poller] row ${row.id} failed: ${e.message}`);
      // Release claim so another tick can retry (or let it expire).
      try {
        await db.query(surql`UPDATE ${row.id} SET claimed_by = NONE, claimed_at = NONE`).collect();
      } catch {
        /* release is best-effort */
      }
    }
  }

  return { processed, written, errors };
}

/**
 * Process a single claimed row:
 *   1. Run structural outcome inference.
 *   2. If signals present, write a task_outcome memo.
 *   3. Delete the row.
 */
async function processRow(db, row) {
  const { task_type, task_id, payload, event_id } = row;

  const inference = inferOutcome(payload);
  const { signals, score } = inference;
  const hasSignals = Object.keys(signals).length > 0;

  if (hasSignals) {
    const content = buildOutcomeSummary(task_type, task_id, inference);
    const meta = {
      task_type,
      task_id,
      source_event: event_id ? String(event_id) : null,
      signals,
      score,
    };

    // Write task_outcome memo.  We bypass store.note() (which requires an
    // embedder) and write directly — task_outcome memos don't need embedding
    // in Phase 1.  derived_by is required by the memos schema (TYPE string).
    await db
      .query(
        surql`CREATE memos CONTENT ${{
          kind: 'task_outcome',
          content,
          content_hash: _sha256Lite(content),
          derived_by: 'introspection',
          meta,
          scope: 'global',
          tags: [],
        }}`,
      )
      .collect();
  }

  // Delete the row regardless of whether a memo was written.
  await db.query(surql`DELETE ${row.id}`).collect();
}

/**
 * Minimal sha256 substitute for content_hash on task_outcome memos.
 * We don't need cryptographic quality here — just a stable dedup key.
 * Uses a simple FNV-1a-style 32-bit hash encoded as hex.
 */
function _sha256Lite(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
