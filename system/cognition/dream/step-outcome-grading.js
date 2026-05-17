// step-outcome-grading.js — Dream step: grade unscored task_outcome rows.
// L1 step, Haiku-tier. Spec §2 "Self-grading rubric" + §6 "Cost budgets".
// FAIL-SOFT: an error here MUST NOT abort the Dream run.
import { surql } from 'surrealdb';
import { parseLLMJSON } from '../biographer/output.js';
import { fetchActivePlaybook } from '../intuition/playbook-inject.js';
import { isSelfImprovementV2Enabled } from '../../runtime/config/self-improvement-v2.js';
import {
  buildGradingSystemPrompt,
  buildGradingUserPrompt,
  computeScore,
  estimateCallCost,
} from './outcome-grading-prompt.js';

// Per-step budget cap (spec §6): $0.20/night
const STEP_BUDGET_USD = 0.2;
// Default batch size — overridable via runtime:introspection.config.value.outcome_grading_batch_size
const DEFAULT_BATCH_SIZE = 50;
// Haiku model id (from system/runtime/hosts/interface.js CLAUDE_TIER_MAP.fast)
const HAIKU_MODEL = 'claude-haiku-4-5';

/**
 * Read the grading batch size from the runtime config KV, falling back to
 * DEFAULT_BATCH_SIZE if the key is absent or unreadable.
 *
 * @param {import('surrealdb').Surreal} db
 * @returns {Promise<number>}
 */
async function readBatchSize(db) {
  try {
    const [rows] = await db
      .query('SELECT VALUE value FROM runtime:`introspection.config`')
      .collect();
    const v = Array.isArray(rows) ? rows[0] : rows;
    const n = v?.outcome_grading_batch_size;
    if (typeof n === 'number' && Number.isInteger(n) && n > 0) return n;
  } catch {
    // Absent / DB error — use default
  }
  return DEFAULT_BATCH_SIZE;
}

/**
 * Fetch up to batchSize ungraded task_outcome memos from the last 24h,
 * ordered by enqueued_at desc (most-recent first).
 *
 * @param {import('surrealdb').Surreal} db
 * @param {number} batchSize
 * @returns {Promise<Array<object>>}
 */
async function fetchUngradedRows(db, batchSize) {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [rows] = await db
    .query(
      surql`SELECT * FROM memos
            WHERE kind = 'task_outcome'
              AND meta.score IS NULL
              AND derived_at >= ${cutoff}
            ORDER BY derived_at DESC
            LIMIT ${batchSize}`,
    )
    .collect();
  return Array.isArray(rows) ? rows.filter(Boolean) : [];
}

/**
 * Fetch up to 3 most-recent graded (score != null) task_outcome rows for the
 * same task_type, for use as calibration anchors in the prompt.
 *
 * @param {import('surrealdb').Surreal} db
 * @param {string} taskType
 * @param {string} excludeId  The id of the row being graded (exclude it).
 * @returns {Promise<Array<object>>}
 */
async function fetchPriorGrades(db, taskType, excludeId) {
  try {
    const [rows] = await db
      .query(
        surql`SELECT meta FROM memos
              WHERE kind = 'task_outcome'
                AND meta.task_type = ${taskType}
                AND meta.score IS NOT NONE
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
 * Fetch the source event content for a task_outcome row.
 * Returns the content string or null if the event isn't found.
 *
 * @param {import('surrealdb').Surreal} db
 * @param {string|null} sourceEventId
 * @returns {Promise<string|null>}
 */
async function fetchSourceEventContent(db, sourceEventId) {
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
 * Write back the score and self_grade signal to a task_outcome memo.
 *
 * @param {import('surrealdb').Surreal} db
 * @param {string|object} memoId
 * @param {number|null} score
 * @param {object} selfGrade  { completeness, correction_likelihood, model, ts }
 */
async function writeGrade(db, memoId, score, selfGrade) {
  await db
    .query(
      surql`UPDATE ONLY ${memoId} SET
              meta.score = ${score},
              meta.signals.self_grade = ${selfGrade}`,
    )
    .collect();
}

/**
 * Grade a single task_outcome row with the Haiku LLM.
 *
 * Returns { score, selfGrade, tokensIn, tokensOut, costUsd } on success.
 * Throws on LLM error so the caller can catch and continue.
 *
 * @param {object} row           — task_outcome memo row
 * @param {object|null} playbook — active playbook for the task_type, or null
 * @param {Array<object>} priorGrades
 * @param {object} host          — HostAdapter (has invokeLLM)
 * @returns {Promise<{score: number|null, selfGrade: object, tokensIn: number, tokensOut: number, costUsd: number}>}
 */
async function gradeRow(row, playbook, priorGrades, sourceEventContent, host) {
  const userPrompt = buildGradingUserPrompt({
    taskType: row.meta?.task_type ?? 'unknown',
    sourceEventContent: sourceEventContent ?? row.content ?? '',
    playbook,
    priorGrades,
  });

  const r = await host.invokeLLM([{ role: 'user', content: userPrompt }], {
    tier: 'fast', // maps to claude-haiku-4-5 per CLAUDE_TIER_MAP
    json: true,
    system: [
      {
        role: 'system',
        content: buildGradingSystemPrompt(),
        cache_control: { type: 'ephemeral' },
      },
    ],
  });

  const tokensIn = r?.usage?.input_tokens ?? 0;
  const tokensOut = r?.usage?.output_tokens ?? 0;
  const costUsd = estimateCallCost(tokensIn, tokensOut);

  const parsed = parseLLMJSON(r.content);

  // Clamp parsed values to [0, 1]; allow null for completeness
  const completeness =
    parsed.completeness !== null && parsed.completeness !== undefined
      ? Math.min(1, Math.max(0, Number(parsed.completeness)))
      : null;
  const correctionLikelihood =
    typeof parsed.correction_likelihood === 'number'
      ? Math.min(1, Math.max(0, parsed.correction_likelihood))
      : 0.5; // fallback

  const score = computeScore(completeness, correctionLikelihood);

  const selfGrade = {
    completeness,
    correction_likelihood: correctionLikelihood,
    // HAIKU_MODEL is hardcoded because InvokeLLMResult (interface.js) does not
    // surface the resolved model name — only content + usage are returned.
    model: HAIKU_MODEL,
    ts: new Date().toISOString(),
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 200) : '',
  };

  return { score, selfGrade, tokensIn, tokensOut, costUsd };
}

/**
 * Dream step: grade unscored task_outcome memos with Haiku.
 *
 * @param {import('surrealdb').Surreal} db
 * @param {object} host      — HostAdapter
 * @param {object} _embedder — unused (required by DAG signature)
 * @param {object} [opts]
 * @param {number} [opts.stepBudgetUsd]   — override the $0.20 cap (for tests)
 * @param {number} [opts.batchSize]       — override batch size (for tests)
 * @returns {Promise<object>}
 */
export async function dreamStepOutcomeGrading(db, host, _embedder, opts = {}) {
  if (!(await isSelfImprovementV2Enabled(db))) {
    return { skipped: true, reason: 'v2_not_enabled', step: 'outcomeGrading' };
  }

  const stepBudgetUsd =
    typeof opts.stepBudgetUsd === 'number' ? opts.stepBudgetUsd : STEP_BUDGET_USD;
  const batchSize = typeof opts.batchSize === 'number' ? opts.batchSize : await readBatchSize(db);

  let rows;
  try {
    rows = await fetchUngradedRows(db, batchSize);
  } catch (err) {
    console.warn(`[dream/outcome-grading] fetch failed: ${err?.message ?? err}`);
    return {
      skipped: false,
      graded: 0,
      skipped_due_to_budget: 0,
      skipped_due_to_error: 1,
      cost_usd: 0,
      step: 'outcomeGrading',
    };
  }

  if (rows.length === 0) {
    return {
      skipped: false,
      graded: 0,
      skipped_due_to_budget: 0,
      skipped_due_to_error: 0,
      cost_usd: 0,
      step: 'outcomeGrading',
    };
  }

  let graded = 0;
  let skippedDueToBudget = 0;
  let skippedDueToError = 0;
  let totalCostUsd = 0;

  for (const row of rows) {
    // Budget check before each call
    if (totalCostUsd >= stepBudgetUsd) {
      // Compute remaining (including this row) before incrementing the counter
      // so the log message is accurate (skippedDueToBudget++ would make it off-by-one).
      const remainingCount = rows.length - graded - skippedDueToBudget - skippedDueToError;
      skippedDueToBudget += remainingCount;
      console.warn(
        `[dream/outcome-grading] step_halted_at_budget: accumulated $${totalCostUsd.toFixed(4)} >= cap $${stepBudgetUsd}; ${remainingCount} rows remain ungraded`,
      );
      break;
    }

    const taskType = row.meta?.task_type ?? null;
    const memoId = row.id;

    try {
      // Fetch active playbook for this task_type (null = cold-start)
      const playbook = taskType ? await fetchActivePlaybook(db, taskType) : null;

      // Fetch prior grades for calibration anchoring
      const priorGrades = taskType ? await fetchPriorGrades(db, taskType, String(memoId)) : [];

      // Fetch source event content
      const sourceEventContent = await fetchSourceEventContent(db, row.meta?.source_event ?? null);

      // Call Haiku
      const { score, selfGrade, costUsd } = await gradeRow(
        row,
        playbook,
        priorGrades,
        sourceEventContent,
        host,
      );

      // Accumulate cost before the write (so a DB write error doesn't lose cost tracking)
      totalCostUsd += costUsd;

      // Write back to memo
      await writeGrade(db, memoId, score, selfGrade);
      graded++;
    } catch (err) {
      // LLM timeout, malformed JSON, DB write error — log and continue
      console.warn(`[dream/outcome-grading] row ${String(memoId)} skipped: ${err?.message ?? err}`);
      skippedDueToError++;
    }
  }

  return {
    skipped: false,
    graded,
    skipped_due_to_budget: skippedDueToBudget,
    skipped_due_to_error: skippedDueToError,
    cost_usd: totalCostUsd,
    step: 'outcomeGrading',
  };
}
