// outcome-grading-prompt.js — Haiku prompt construction for task_outcome grading.
//
// Extracted here so the Sub-Wave 3-B introspection inline-grading path can
// reuse the same prompt logic without coupling it to step-outcome-grading.js.
//
// Spec §2 "Self-grading rubric":
//   - completeness: binary coverage of playbook.declared_sections, averaged (0..1).
//     null when no playbook (cold-start path).
//   - correction_likelihood: LLM probability the user would correct this outcome.
//   - score = mean(completeness, correction_likelihood) when both exist;
//             correction_likelihood when no playbook.
//
// Output shape returned by the LLM (JSON):
//   { completeness: number|null, correction_likelihood: number, rationale: string }

import { estimateCostUsd } from '../../runtime/hosts/pricing.js';

/**
 * Build the system prompt (cacheable).
 *
 * @returns {string}
 */
export function buildGradingSystemPrompt() {
  return `You are a quality-grading assistant for an AI assistant called Robin.
Your job is to evaluate how well Robin completed a specific task.

You will receive:
1. A task outcome: what happened when Robin attempted the task.
2. An optional playbook: the declared recipe/sections Robin should follow for this task type.
3. Up to 3 prior grades for this task type (for calibration).

Return ONLY valid JSON (no markdown, no explanation) in this exact shape:
{
  "completeness": <0.0 to 1.0 or null>,
  "correction_likelihood": <0.0 to 1.0>,
  "rationale": "<one concise sentence>"
}

Scoring rules:
- completeness: fraction of declared_sections from the playbook that were addressed in the outcome.
  Set to null when no playbook is provided (cold-start).
- correction_likelihood: your estimate (0..1) that a user would send a correction after seeing this output.
  0 = clearly excellent, 1 = almost certainly incorrect or missing something important.
- rationale: one sentence explaining the key strength or weakness driving the scores.

Be calibrated: use the prior grades to anchor your scale. If prior grades are all 0.2, a similar
outcome should score similarly — don't grade in isolation.`;
}

/**
 * Build the user prompt for a single task_outcome row.
 *
 * @param {object} opts
 * @param {string} opts.taskType - The task_type identifier (e.g. 'job:daily-briefing').
 * @param {string} opts.sourceEventContent - The content of the source event being graded.
 * @param {object|null} opts.playbook - The active playbook memo row, or null for cold-start.
 * @param {Array<object>} opts.priorGrades - Up to 3 prior graded task_outcome rows.
 * @returns {string}
 */
export function buildGradingUserPrompt({ taskType, sourceEventContent, playbook, priorGrades }) {
  const lines = [];

  lines.push(`Task type: ${taskType}`);
  lines.push('');

  // Source event / outcome content
  lines.push('=== TASK OUTCOME ===');
  lines.push(sourceEventContent || '(no source event content available)');
  lines.push('');

  // Playbook (if any)
  if (playbook) {
    const sections = playbook.meta?.declared_sections;
    const playbookBody = typeof playbook.content === 'string' ? playbook.content : '';
    lines.push('=== ACTIVE PLAYBOOK ===');
    if (sections && Array.isArray(sections) && sections.length > 0) {
      lines.push(`Declared sections: ${sections.join(', ')}`);
    }
    if (playbookBody) {
      // Cap at ~2000 chars to stay within Haiku input budget
      const capped = playbookBody.length > 2000 ? `${playbookBody.slice(0, 2000)}\n[truncated]` : playbookBody;
      lines.push(capped);
    }
    lines.push('');
  } else {
    lines.push('=== PLAYBOOK ===');
    lines.push('(none — cold-start path; set completeness=null)');
    lines.push('');
  }

  // Prior grades for calibration
  if (priorGrades && priorGrades.length > 0) {
    lines.push('=== PRIOR GRADES (same task type, most recent first) ===');
    for (const pg of priorGrades.slice(0, 3)) {
      const sg = pg.meta?.signals?.self_grade;
      if (!sg) continue;
      const c = sg.completeness != null ? sg.completeness.toFixed(2) : 'null';
      const cl = sg.correction_likelihood != null ? sg.correction_likelihood.toFixed(2) : '?';
      lines.push(`- completeness=${c} correction_likelihood=${cl}`);
    }
    lines.push('');
  }

  lines.push('Grade this task outcome now. Return JSON only.');

  return lines.join('\n');
}

/**
 * Compute the final scalar score from completeness + correction_likelihood.
 *
 * - Both present: mean(completeness, correction_likelihood)
 * - No playbook (completeness=null): score = correction_likelihood
 * - correction_likelihood missing or invalid: score = null
 *
 * @param {number|null} completeness
 * @param {number|null} correctionLikelihood
 * @returns {number|null}
 */
export function computeScore(completeness, correctionLikelihood) {
  const cl = typeof correctionLikelihood === 'number' && Number.isFinite(correctionLikelihood)
    ? Math.min(1, Math.max(0, correctionLikelihood))
    : null;
  if (cl === null) return null;

  if (completeness === null || completeness === undefined) {
    // Cold-start: no playbook
    return cl;
  }

  const comp = typeof completeness === 'number' && Number.isFinite(completeness)
    ? Math.min(1, Math.max(0, completeness))
    : null;
  if (comp === null) return cl;

  return (comp + cl) / 2;
}

/**
 * Estimate cost in USD for a single Haiku LLM call given token counts.
 * Delegates to the shared pricing module so constants don't drift.
 *
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @returns {number}
 */
export function estimateCallCost(inputTokens, outputTokens) {
  return estimateCostUsd('haiku', inputTokens, outputTokens);
}
