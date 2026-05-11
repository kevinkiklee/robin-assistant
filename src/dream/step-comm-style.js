// src/dream/step-comm-style.js — Dream step: synthesize comm-style preferences.
// FAIL-SOFT: an error here MUST NOT abort the Dream run.
import { synthesizeCommStyle } from '../jobs/comm-style.js';

export async function dreamStepCommStyle(db, host) {
  try {
    const result = await synthesizeCommStyle(db, host);
    if (!result.ok) {
      console.warn(`[dream] step-comm-style: ${result.reason ?? 'unknown'}`);
    }
    return result;
  } catch (e) {
    console.warn(`[dream] step-comm-style: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}
