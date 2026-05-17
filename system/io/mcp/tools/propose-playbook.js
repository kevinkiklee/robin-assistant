import { isSelfImprovementV2Enabled } from '../../../runtime/config/self-improvement-v2.js';

export function createProposePlaybookTool({ db }) {
  return {
    name: 'propose_playbook',
    description:
      'Submit a draft playbook for a recurring task type. The playbook is queued for dream-cycle review before becoming active; existing active playbooks for the same task_type are superseded on approval.',
    inputSchema: {
      type: 'object',
      properties: {
        task_type: { type: 'string', minLength: 1, maxLength: 200 },
        draft: { type: 'string', minLength: 1, maxLength: 20000 },
        source_outcomes: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
        },
      },
      required: ['task_type', 'draft', 'source_outcomes'],
    },
    handler: async (args) => {
      const enabled = await isSelfImprovementV2Enabled(db);
      if (!enabled) return { ok: false, reason: 'v2_not_enabled' };
      return { ok: false, reason: 'not_implemented_yet', stub: true };
    },
  };
}
