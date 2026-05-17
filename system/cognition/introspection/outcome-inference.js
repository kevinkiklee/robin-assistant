// outcome-inference.js — pure structural outcome-inference functions (v1).
//
// No DB calls, no I/O. Input: a task_close_queue payload object.
// Output: { signals, score } — merged into the task_outcome memo.
//
// Three v1 rules implemented (spec §2 "Outcome inference rules"):
//   1. outbound_blocked     — outbound-policy ok=false on a task's output.
//   2. recall_fingerprint_reuse — same recall fingerprint seen twice in a
//      session with disjoint top-K hit IDs.
//   3. explicit_correction_followup — record_correction({source_event=X})
//      within OUTCOME_INFERENCE_WINDOWS.correction_followup_window_sec of X.
//
// v1.5 deferred: re-ask detection, abandoned-thread timer.

import { OUTCOME_INFERENCE_SCORES, OUTCOME_INFERENCE_WINDOWS } from './inference-rules.js';

/**
 * Run all v1 structural rules against the queue row payload.
 *
 * @param {object} payload — raw `payload` field from a task_close_queue row.
 *   Expected sub-fields (any may be absent/null without throwing):
 *     - outbound_result   { ok, reason }     — for outbound_blocked rule
 *     - recall_signal     { fingerprint, top_k_ids[], session_prior_top_k_ids[] }
 *                                            — for recall_fingerprint_reuse rule
 *     - correction_followup { is_followup }  — for explicit_correction rule
 *       OR correction_followup_sec (numeric lag)
 *
 * @returns {{ signals: object, score: number|null }}
 *   signals has at most one key per rule that fires; score is the lowest
 *   (most severe) score of all firing rules, or null if none fire.
 */
export function inferOutcome(payload) {
  if (!payload || typeof payload !== 'object') {
    return { signals: {}, score: null };
  }

  const signals = {};
  const scores = [];

  // ── Rule 1: outbound_blocked ─────────────────────────────────────────────
  // The job/outbound close emitter sets payload.outbound_result = { ok: false, reason }
  // when the outbound policy blocked the write.
  if (
    payload.outbound_result &&
    typeof payload.outbound_result === 'object' &&
    payload.outbound_result.ok === false
  ) {
    signals.outbound_blocked = {
      reason: payload.outbound_result.reason ?? 'unknown',
    };
    scores.push(OUTCOME_INFERENCE_SCORES.outbound_blocked);
  }

  // ── Rule 2: recall_fingerprint_reuse ─────────────────────────────────────
  // A recall emitter sets payload.recall_signal = { fingerprint, top_k_ids,
  // session_prior_top_k_ids }.  The rule fires when the same fingerprint
  // appeared earlier in the session AND the two top-K result sets are
  // disjoint (no shared IDs → first call was a miss).
  if (payload.recall_signal && typeof payload.recall_signal === 'object') {
    const { fingerprint, top_k_ids, session_prior_top_k_ids } = payload.recall_signal;
    if (
      fingerprint &&
      Array.isArray(top_k_ids) &&
      Array.isArray(session_prior_top_k_ids) &&
      session_prior_top_k_ids.length > 0
    ) {
      const priorSet = new Set(session_prior_top_k_ids.map(String));
      const disjoint = top_k_ids.every((id) => !priorSet.has(String(id)));
      if (disjoint) {
        signals.recall_fingerprint_reuse = {
          fingerprint,
          prior_top_k_count: session_prior_top_k_ids.length,
          current_top_k_count: top_k_ids.length,
        };
        scores.push(OUTCOME_INFERENCE_SCORES.recall_fingerprint_reuse);
      }
    }
  }

  // ── Rule 3: explicit_correction_followup ─────────────────────────────────
  // The correction-inference module sets either:
  //   payload.correction_followup = { is_followup: true }
  //   payload.correction_followup_sec = <number>  (seconds since turn close)
  // Either form fires the rule when within the time window.
  const cf = payload.correction_followup;
  const lagSec = payload.correction_followup_sec;
  const windowSec = OUTCOME_INFERENCE_WINDOWS.correction_followup_window_sec;

  const followupByFlag = cf && typeof cf === 'object' && cf.is_followup === true;
  const followupByLag = typeof lagSec === 'number' && lagSec >= 0 && lagSec <= windowSec;

  if (followupByFlag || followupByLag) {
    signals.explicit_correction = {
      ...(typeof lagSec === 'number' ? { lag_sec: lagSec } : {}),
    };
    // Explicit corrections are authoritative (score = 0).
    scores.push(OUTCOME_INFERENCE_SCORES.explicit_correction);
  }

  const score = scores.length > 0 ? Math.min(...scores) : null;
  return { signals, score };
}

/**
 * Build a one-line content summary for the task_outcome memo from inference
 * results.  Used as the memo's `content` field.
 *
 * @param {string} taskType
 * @param {string} taskId
 * @param {{ signals: object, score: number|null }} inference
 * @returns {string}
 */
export function buildOutcomeSummary(taskType, taskId, inference) {
  const { signals, score } = inference;
  const ruleNames = Object.keys(signals);
  if (ruleNames.length === 0) {
    return `task_outcome ${taskType}/${taskId}: no structural signals (score=null)`;
  }
  const scoreStr = score === null ? 'null' : score.toFixed(2);
  const rules = ruleNames.join(', ');
  return `task_outcome ${taskType}/${taskId}: ${rules} (score=${scoreStr})`;
}
