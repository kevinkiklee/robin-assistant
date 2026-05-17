// step-outcome-grading.js — Dream step: grade unscored task_outcome rows.
// L1 step, Haiku-tier. Phase 1 stub — gated on runtime:self-improvement-v2.
// Wave 3: read ungraded task_outcome rows from last 24h, LLM-score each.
// FAIL-SOFT: an error here MUST NOT abort the Dream run.
import { isSelfImprovementV2Enabled } from '../../runtime/config/self-improvement-v2.js';

export async function dreamStepOutcomeGrading(db, host, embedder, opts) {
  if (!(await isSelfImprovementV2Enabled(db))) {
    return { skipped: true, reason: 'v2_not_enabled', step: 'outcomeGrading' };
  }
  // Wave 3: read ungraded task_outcome rows from last 24h, LLM-score each.
  return { skipped: true, reason: 'phase_1_stub', step: 'outcomeGrading' };
}
