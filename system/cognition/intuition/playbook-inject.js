// playbook-inject.js — Three-tier task-type classifier + playbook fetch for
// the inject path.
//
// Tier 1 (declared): jobs and outbound writes carry task_type in the turn
//   context; use it directly, skip the classifier.
// Tier 2 (routed): recall queries are bucketed by a pattern table.
// Tier 3 (classified): general assistant turns hit the Haiku classifier, but
//   only when at least one turn:* playbook exists AND the per-session cache
//   is cold or has been invalidated by a low-similarity turn.
//
// When no host is supplied (e.g. in tests that don't inject a host adapter),
// classifyTurnType gracefully skips Tier 3 and returns 'turn:default'.

import { surql } from 'surrealdb';
import { isSelfImprovementV2Enabled } from '../../runtime/config/self-improvement-v2.js';
import { tokenCapForTaskType } from '../introspection/task-taxonomy.js';
import { classifyTurnType } from './turn-classifier.js';

/**
 * Fetch the active playbook memo for the given task_type.
 *
 * Returns the full memo row when exactly one active playbook exists, or null
 * when none match or when a DB error occurs (caught + logged here so the
 * caller never sees a throw).
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
 * @param {object} [turnContext]
 *   Passed through to classifyTurnType.
 *   Shape: { query?: string, task_type?: string, session_id?: string }
 * @param {{invokeLLM: Function}} [host]
 *   Optional host adapter.  When supplied, Tier-3 Haiku classification fires.
 *   When absent (e.g. in unit tests), the classifier falls back to Tier 1/2
 *   only and returns 'turn:default' for general turns.
 * @param {{embed:(t:string)=>Promise<Float32Array>}} [embedder]
 *   Optional embedder for per-session cache similarity.
 * @returns {Promise<string|null>}
 */
export async function getPlaybookForInject(db, turnContext, host, embedder) {
  try {
    const enabled = await isSelfImprovementV2Enabled(db);
    if (!enabled) return null;

    const taskType = await classifyTurnType(db, turnContext, host, embedder);
    const playbook = await fetchActivePlaybook(db, taskType);
    if (!playbook) return null;

    const content = typeof playbook.content === 'string' ? playbook.content : null;
    if (!content) return null;

    const cap = tokenCapForTaskType(taskType) ?? 800;
    return truncateToTokenCap(content, cap);
  } catch (err) {
    console.warn('[playbook-inject] getPlaybookForInject error:', err?.message ?? err);
    return null;
  }
}
