// src/dream/step-calibration.js — Dream step: refresh prediction calibration.
// FAIL-SOFT: an error here MUST NOT abort the Dream run.
import { computeCalibration, setCalibration } from '../jobs/predictions.js';

export async function dreamStepCalibration(db) {
  try {
    const c = await computeCalibration(db);
    await setCalibration(db, c);
    return { ok: true, total_resolved: c.total_resolved };
  } catch (e) {
    console.warn(`[dream] step-calibration: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}
