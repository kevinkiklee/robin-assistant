import { isSelfImprovementV2Enabled } from '../../../runtime/config/self-improvement-v2.js';

export function createGetPlaybookTool({ db }) {
  return {
    name: 'get_playbook',
    description:
      'Fetch a single playbook by ID, including its full step-by-step content, task_type, status, and the outcome IDs that sourced it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
      },
      required: ['id'],
    },
    handler: async (args) => {
      const enabled = await isSelfImprovementV2Enabled(db);
      if (!enabled) return { ok: false, reason: 'v2_not_enabled' };
      return { ok: false, reason: 'not_implemented_yet', stub: true };
    },
  };
}
