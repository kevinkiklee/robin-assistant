// step-calibration-bucket.js — Dream step: compute confidence_band memos.
// L2 step, pure math. Sole writer of `confidence_band` memos.
// Phase 1 stub — gated on runtime:self-improvement-v2.
// Wave 3: bucket resolved predictions by declared confidence range, compute
//         calibration error per band, write confidence_band memos.
// FAIL-SOFT: an error here MUST NOT abort the Dream run.
import { isSelfImprovementV2Enabled } from '../../runtime/config/self-improvement-v2.js';

export async function dreamStepCalibrationBucket(db) {
  if (!(await isSelfImprovementV2Enabled(db))) {
    return { skipped: true, reason: 'v2_not_enabled', step: 'calibrationBucket' };
  }
  // Wave 3: bucket predictions by confidence range, compute calibration error,
  //         write confidence_band memos.
  return { skipped: true, reason: 'phase_1_stub', step: 'calibrationBucket' };
}
