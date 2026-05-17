import { isSelfImprovementV2Enabled } from '../../../runtime/config/self-improvement-v2.js';

export function createGetCalibrationTool({ db }) {
  return {
    name: 'get_calibration',
    description:
      "Read Robin's current decision calibration: confidence bands by statement kind, prediction accuracy, and Brier score history. Optionally filter to a specific statement_kind.",
    inputSchema: {
      type: 'object',
      properties: {
        statement_kind: { type: 'string', minLength: 1, maxLength: 100 },
      },
    },
    handler: async (args) => {
      const enabled = await isSelfImprovementV2Enabled(db);
      if (!enabled) return { ok: false, reason: 'v2_not_enabled' };
      return { ok: false, reason: 'not_implemented_yet', stub: true };
    },
  };
}
