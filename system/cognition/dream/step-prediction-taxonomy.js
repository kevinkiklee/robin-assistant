// step-prediction-taxonomy.js — Dream step: cluster 'other' predictions.
// L2 step, weekly cadence (runner gates the weekly window). Proposes new
// enum entries for kind='other' prediction clusters.
// Phase 1 stub — gated on runtime:self-improvement-v2.
// Wave 3: cluster kind='other' predictions, propose new enum entries via LLM.
// FAIL-SOFT: an error here MUST NOT abort the Dream run.
import { isSelfImprovementV2Enabled } from '../../runtime/config/self-improvement-v2.js';

export async function dreamStepPredictionTaxonomy(db, host) {
  if (!(await isSelfImprovementV2Enabled(db))) {
    return { skipped: true, reason: 'v2_not_enabled', step: 'predictionTaxonomy' };
  }
  // Wave 3: cluster kind='other' predictions, propose new enum entries.
  return { skipped: true, reason: 'phase_1_stub', step: 'predictionTaxonomy' };
}
