// playbook-inject.js — Phase 1 stub for inject-path playbook fetch.
//
// Wires the "fetch active playbook for current task_type and prepend to inject
// result" path described in spec §3 "Inject-path integration".
//
// Phase 1 reality:
//   - Classifier is a stub that always returns 'turn:default'.
//   - Playbook table is empty until Wave 3's step-playbook-synthesis runs.
//   So in practice getPlaybookForInject returns null on every call in Phase 1.
//   The wiring exists and is tested; the no-op is intentional.
//
// Wave 3 follow-ups:
//   - classifyTaskType: swap stub for Haiku classifier.
//   - Token counting: optionally swap chars/4 for a real tokenizer.

import { surql } from 'surrealdb';
import { isSelfImprovementV2Enabled } from '../../runtime/config/self-improvement-v2.js';
import { tokenCapForTaskType } from '../introspection/task-taxonomy.js';

/**
 * Phase 1 stub: always returns 'turn:default'.
 * Wave 3 wires the real Haiku classifier here.
 *
 * @param {object} _turnContext  Ignored in Phase 1.
 * @returns {string}
 */
export function classifyTaskType(_turnContext) {
  // NOTE: Wave 3 replaces this stub with a Haiku-tier classifier that reads
  // the current turn's message and returns the appropriate task_type.
  return 'turn:default';
}

/**
 * Fetch the active playbook memo for the given task_type.
 *
 * Returns the full memo row when exactly one active playbook exists, or null
 * when none match (normal in Phase 1) or when a DB error occurs (caught +
 * logged here so the caller never sees a throw).
 *
 * @param {import('surrealdb').Surreal} db
 * @param {string} taskType
 * @returns {Promise<object|null>}
 */
export async function fetchActivePlaybook(db, taskType) {
  try {
    const [rows] = await db
      .query(
        surql`SELECT * FROM memos WHERE kind = 'playbook' AND meta.task_type = ${taskType} AND meta.active = true LIMIT 1`,
      )
      .collect();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return rows[0] ?? null;
  } catch (err) {
    console.warn('[playbook-inject] fetchActivePlaybook error:', err?.message ?? err);
    return null;
  }
}

/**
 * Cheap token estimator: 1 token ≈ 4 chars.
 * Same heuristic used elsewhere in inject.js.
 * Wave 3 may swap in a real tokenizer.
 */
function estimateTokens(s) {
  return Math.ceil((typeof s === 'string' ? s.length : 0) / 4);
}

/**
 * Truncate content so it fits within the token cap for the given task_type.
 * Returns the content unchanged when it already fits.
 *
 * @param {string} content
 * @param {number} capTokens
 * @returns {string}
 */
function truncateToTokenCap(content, capTokens) {
  if (typeof content !== 'string') return '';
  const currentTokens = estimateTokens(content);
  if (currentTokens <= capTokens) return content;
  // chars/4 → cap*4 chars gives us exactly capTokens.
  return [...content].slice(0, capTokens * 4).join('');
}

/**
 * Top-level entry point: classify the current turn → fetch playbook → truncate.
 *
 * Returns the playbook content string (possibly truncated) when:
 *   - isSelfImprovementV2Enabled is true, AND
 *   - an active playbook exists for the classified task_type.
 *
 * Returns null when the flag is off, no playbook is found, or any error occurs.
 * NEVER throws — all errors are caught, logged, and silently skipped.
 *
 * @param {import('surrealdb').Surreal} db
 * @param {object} [turnContext]  Passed through to classifyTaskType (Phase 1: ignored).
 * @returns {Promise<string|null>}
 */
export async function getPlaybookForInject(db, turnContext) {
  try {
    const enabled = await isSelfImprovementV2Enabled(db);
    if (!enabled) return null;

    const taskType = classifyTaskType(turnContext);
    const playbook = await fetchActivePlaybook(db, taskType);
    if (!playbook) return null;

    const content = typeof playbook.content === 'string' ? playbook.content : null;
    if (!content) return null;

    // Use the task_type's declared cap; fall back to a safe 800-token default.
    const cap = tokenCapForTaskType(taskType) ?? 800;
    return truncateToTokenCap(content, cap);
  } catch (err) {
    console.warn('[playbook-inject] getPlaybookForInject error:', err?.message ?? err);
    return null;
  }
}
