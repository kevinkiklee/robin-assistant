import { isSelfImprovementV2Enabled } from '../../../runtime/config/self-improvement-v2.js';

export function createExplainLearningTool({ db }) {
  return {
    name: 'explain_learning',
    description:
      'Explain the provenance of a specific learned artifact — a task_outcome memo, a rule from a rule candidate, or a resolved prediction. Exactly one of memo_id, rule_id, or prediction_id must be provided.',
    inputSchema: {
      type: 'object',
      properties: {
        memo_id: { type: 'string', minLength: 1 },
        rule_id: { type: 'string', minLength: 1 },
        prediction_id: { type: 'string', minLength: 1 },
      },
    },
    handler: async (args) => {
      // Validate exactly one of the three identifiers is present
      const provided = [args.memo_id, args.rule_id, args.prediction_id].filter(
        (v) => v !== undefined && v !== null,
      );
      if (provided.length !== 1) {
        return { ok: false, reason: 'exactly_one_id_required' };
      }

      const enabled = await isSelfImprovementV2Enabled(db);
      if (!enabled) return { ok: false, reason: 'v2_not_enabled' };
      return { ok: false, reason: 'not_implemented_yet', stub: true };
    },
  };
}
