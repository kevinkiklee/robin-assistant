// dispatch.js — single entry point per trigger-eligible step. Theme 3.

import { dreamStepCalibration } from './step-calibration.js';
import { dreamStepCommStyle } from './step-comm-style.js';
import { dreamStepReflection } from './step-reflection.js';

const REGISTRY = {
  reflection: dreamStepReflection,
  'comm-style': dreamStepCommStyle,
  calibration: dreamStepCalibration,
};

export async function dispatchStep(db, host, stepName, opts = {}) {
  const fn = REGISTRY[stepName];
  if (!fn) throw new Error(`dispatch: unknown step '${stepName}'`);
  const result = await fn(db, host, opts);
  // Normalise tokens / processed_until if step didn't supply them.
  return {
    ...result,
    tokens_in: result?.tokens_in ?? 0,
    tokens_out: result?.tokens_out ?? 0,
    processed_until: result?.processed_until ?? null,
  };
}
