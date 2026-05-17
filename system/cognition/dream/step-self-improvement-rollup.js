// step-self-improvement-rollup.js — Dream step: write v2 metrics rollup.
// L3 step; depends on all other v2 steps. Writes runtime:self-improvement-v2.metrics.
// Phase 1 stub — gated on runtime:self-improvement-v2.
// Wave 3: aggregate outcomes from the upstream v2 steps and upsert the
//         runtime:self-improvement-v2.metrics row.
// FAIL-SOFT: an error here MUST NOT abort the Dream run.
import { isSelfImprovementV2Enabled } from '../../runtime/config/self-improvement-v2.js';

export async function dreamStepSelfImprovementRollup(db) {
  if (!(await isSelfImprovementV2Enabled(db))) {
    return { skipped: true, reason: 'v2_not_enabled', step: 'selfImprovementRollup' };
  }
  // Wave 3: aggregate outcomes from upstream v2 steps, upsert metrics row.
  return { skipped: true, reason: 'phase_1_stub', step: 'selfImprovementRollup' };
}
