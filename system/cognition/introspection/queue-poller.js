// queue-poller.js — claim rows from task_close_queue, run structural
// outcome inference (and optional LLM grading), write task_outcome memos,
// delete claimed rows.
//
// Called once per drain tick (1 min interval in faculty.js).
// Each call processes up to DRAIN_BATCH_SIZE unclaimed, non-expired rows.
//
// Spec §2: outcome inference rules v1:
//   - outbound_blocked
//   - recall_fingerprint_reuse
//   - explicit_correction_followup
//
// Wave 3 inline grading:
//   When a `host` object is provided AND the row has score=null after
//   structural inference, call Haiku to fill the score (strata-gated).
//   Strata priority:
//     1. predictions + corrections — always (free, no LLM)
//     2. outbound  — always up to budget exhaustion
//     3. jobs      — always up to budget
//     4. recall    — 100% until 25% remaining, then 25%
//     5. turns     — at turn_sample_pct (auto-tuned); 0 below 10% remaining
//
// Claim semantics: UPDATE … SET claimed_by / claimed_at WHERE claimed_at = NONE
// AND expires_at > now(). SurrealDB serialises updates on the same record ID,
// so two concurrent drain ticks won't double-claim a row.

import { surql } from 'surrealdb';
import { parseLLMJSON } from '../biographer/output.js';
import { fetchActivePlaybook } from '../intuition/playbook-inject.js';
import {
  buildGradingSystemPrompt,
  buildGradingUserPrompt,
  computeScore,
  estimateCallCost,
} from '../dream/outcome-grading-prompt.js';
import {
  isStratumAllowed,
  readBudgetConfig,
  readBudgetState,
  recordActualCost,
  tryReserveCost,
} from './budget.js';
import { buildOutcomeSummary, inferOutcome } from './outcome-inference.js';
import { parseTaskType } from './task-taxonomy.js';

const DRAIN_BATCH_SIZE = 50;
const DAEMON_ID = process.pid.toString();
const HAIKU_MODEL = 'claude-haiku-4-5';

// Estimated token counts per Haiku call (used for pre-call budget reservation).
// Conservative over-estimate; recordActualCost corrects afterwards.
const EST_INPUT_TOKENS = 800;
const EST_OUTPUT_TOKENS = 80;

/**
 * Run one drain tick: claim ≤ DRAIN_BATCH_SIZE rows, infer outcomes,
 * write task_outcome memos for rows with signals, delete processed rows.
 *
 * When `host` is provided (non-null), applies inline LLM grading for rows
 * whose score is still null after structural inference, subject to strata
 * priority + budget gating (spec §2).
 *
 * @param {object} db   — SurrealDB handle
 * @param {object|null} [host] — HostAdapter with invokeLLM; null = no LLM grading
 * @returns {{ processed: number, written: number, errors: number, graded: number }}
 */
export async function drainQueueOnce(db, host = null) {
  const now = new Date();
  let processed = 0;
  let written = 0;
  let errors = 0;
  let graded = 0;

  // Pre-read budget config + state once per drain tick (amortizes DB reads).
  let budgetCfg = null;
  let budgetState = null;
  if (host) {
    try {
      budgetCfg = await readBudgetConfig(db);
      budgetState = await readBudgetState(db);
    } catch {
      // Budget read failed — proceed without LLM grading this tick.
      host = null;
    }
  }

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
  if (candidates.length === 0) return { processed: 0, written: 0, errors: 0, graded: 0 };

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
  if (rows.length === 0) return { processed: 0, written: 0, errors: 0, graded: 0 };

  for (const row of rows) {
    processed++;
    try {
      const didGrade = await processRow(db, row, host, budgetCfg, budgetState);
      if (didGrade) graded++;
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

  return { processed, written, errors, graded };
}

/**
 * Process a single claimed row:
 *   1. Run structural outcome inference.
 *   2. If signals present OR LLM grading is available, write a task_outcome memo.
 *   3. Optionally call Haiku for inline grading when score=null and budget allows.
 *   4. Delete the row.
 *
 * Returns true when LLM grading was performed.
 *
 * @param {object} db
 * @param {object} row
 * @param {object|null} host        — HostAdapter; null = no LLM grading
 * @param {object|null} budgetCfg   — pre-read budget config (or null)
 * @param {object|null} budgetState — pre-read budget state (or null)
 * @returns {Promise<boolean>} — true if LLM grading was performed
 */
async function processRow(db, row, host = null, budgetCfg = null, budgetState = null) {
  const { task_type, task_id, payload, event_id } = row;

  const inference = inferOutcome(payload);
  const { signals, score: structuralScore } = inference;
  const hasSignals = Object.keys(signals).length > 0;

  // Determine whether to attempt LLM grading.
  // Skip when: no host, structural score already set, or row is a free
  // stratum (predictions / explicit_correction — already handled structurally).
  let didGrade = false;
  let finalScore = structuralScore;
  let selfGradeSignal = null;

  const needsLlmGrade = host !== null && finalScore === null;

  if (needsLlmGrade) {
    const gradeResult = await _tryInlineGrade(
      db,
      row,
      task_type,
      host,
      budgetCfg,
      budgetState,
    );
    if (gradeResult) {
      finalScore = gradeResult.score;
      selfGradeSignal = gradeResult.selfGrade;
      didGrade = true;
    }
  }

  if (hasSignals || finalScore !== null) {
    const updatedInference = { signals, score: finalScore };
    const content = buildOutcomeSummary(task_type, task_id, updatedInference);
    const meta = {
      task_type,
      task_id,
      source_event: event_id ? String(event_id) : null,
      signals,
      score: finalScore,
      ...(selfGradeSignal ? { signals: { ...signals, self_grade: selfGradeSignal } } : {}),
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
  return didGrade;
}

/**
 * Attempt inline LLM grading for a queue row.
 *
 * Applies strata-priority sampling, reserves budget, calls Haiku, corrects
 * actual spend.  Returns { score, selfGrade } on success, null on skip/error.
 *
 * @param {object} db
 * @param {object} row
 * @param {string} taskType
 * @param {object} host
 * @param {object|null} cfg
 * @param {object|null} state
 * @returns {Promise<{score: number|null, selfGrade: object}|null>}
 */
async function _tryInlineGrade(db, row, taskType, host, cfg, state) {
  // Determine stratum from task_type prefix.
  const parsed = parseTaskType(taskType);
  const stratum = parsed?.prefix ?? 'turns'; // unknown → treat as turns (most restrictive)

  // Map task-taxonomy prefix to budget stratum name.
  const stratumMap = {
    job: 'jobs',
    outbound: 'outbound',
    recall: 'recall',
    turn: 'turns',
  };
  const budgetStratum = stratumMap[stratum] ?? 'turns';

  // predictions + explicit_correction are structurally graded (score always set).
  // If we reach here with score=null, it's a non-correction row — check strata.
  const gate = isStratumAllowed(budgetStratum, cfg, state);
  if (!gate.allowed) return null;

  // Probabilistic sampling for recall and turns.
  if (typeof gate.samplePct === 'number' && gate.samplePct < 100) {
    if (Math.random() * 100 >= gate.samplePct) return null;
  }

  // Estimate cost and reserve budget.
  const estimatedCost = estimateCallCost(EST_INPUT_TOKENS, EST_OUTPUT_TOKENS);
  const reservation = await tryReserveCost(db, estimatedCost);
  if (!reservation.ok) {
    // Budget exhausted.
    return null;
  }

  // Start at 0; only ratchet up on the success path. This way an LLM throw
  // → finally → recordActualCost(0, estimatedCost) → delta = -estimatedCost
  // → reserved budget refunded.
  let actualCost = 0;
  try {
    // Fetch supporting data for the prompt.
    const playbook = taskType ? await fetchActivePlaybook(db, taskType).catch(() => null) : null;
    const priorGrades = await _fetchPriorGrades(db, taskType, String(row.id));
    const sourceEventContent = await _fetchSourceEventContent(db, row.event_id ?? null);

    const userPrompt = buildGradingUserPrompt({
      taskType,
      sourceEventContent: sourceEventContent ?? row.content ?? '',
      playbook,
      priorGrades,
    });

    const r = await host.invokeLLM([{ role: 'user', content: userPrompt }], {
      tier: 'fast',
      json: true,
      system: [
        {
          role: 'system',
          content: buildGradingSystemPrompt(),
          cache_control: { type: 'ephemeral' },
        },
      ],
    });

    const tokensIn = r?.usage?.input_tokens ?? EST_INPUT_TOKENS;
    const tokensOut = r?.usage?.output_tokens ?? EST_OUTPUT_TOKENS;
    actualCost = estimateCallCost(tokensIn, tokensOut);

    const parsed = parseLLMJSON(r.content);

    const completeness =
      parsed.completeness !== null && parsed.completeness !== undefined
        ? Math.min(1, Math.max(0, Number(parsed.completeness)))
        : null;
    const correctionLikelihood =
      typeof parsed.correction_likelihood === 'number'
        ? Math.min(1, Math.max(0, parsed.correction_likelihood))
        : 0.5;

    const score = computeScore(completeness, correctionLikelihood);

    const selfGrade = {
      completeness,
      correction_likelihood: correctionLikelihood,
      // HAIKU_MODEL is hardcoded because InvokeLLMResult (interface.js) does not
      // surface the resolved model name — only content + usage are returned.
      model: HAIKU_MODEL,
      ts: new Date().toISOString(),
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 200) : '',
      cost_usd: actualCost,
    };

    return { score, selfGrade };
  } catch (err) {
    console.warn(`[introspection/queue-poller] inline grade failed for ${row.id}: ${err?.message ?? err}`);
    return null;
  } finally {
    // Correct budget for actual vs estimated spend.
    await recordActualCost(db, actualCost, estimatedCost).catch(() => {});
  }
}

/**
 * Fetch up to 3 most-recent graded task_outcome rows for the same task_type.
 * Used as calibration anchors in the grading prompt.
 */
async function _fetchPriorGrades(db, taskType, excludeId) {
  try {
    const [rows] = await db
      .query(
        surql`SELECT meta FROM memos
              WHERE kind = 'task_outcome'
                AND meta.task_type = ${taskType}
                AND meta.score IS NOT NULL
                AND id != ${excludeId}
              ORDER BY derived_at DESC
              LIMIT 3`,
      )
      .collect();
    return Array.isArray(rows) ? rows.filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Fetch the content of the source event for a queue row.
 */
async function _fetchSourceEventContent(db, sourceEventId) {
  if (!sourceEventId) return null;
  try {
    const [rows] = await db
      .query(surql`SELECT content FROM events WHERE id = ${sourceEventId} LIMIT 1`)
      .collect();
    const r = Array.isArray(rows) ? rows[0] : rows;
    return typeof r?.content === 'string' ? r.content : null;
  } catch {
    return null;
  }
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
