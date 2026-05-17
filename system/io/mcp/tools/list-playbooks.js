import { isSelfImprovementV2Enabled } from '../../../runtime/config/self-improvement-v2.js';

export function createListPlaybooksTool({ db }) {
  return {
    name: 'list_playbooks',
    description:
      "List Robin's learned playbooks — synthesized step-by-step guides for recurring task types. Filter by task_type or list all active playbooks.",
    inputSchema: {
      type: 'object',
      properties: {
        task_type: { type: 'string', minLength: 1, maxLength: 200 },
        active_only: { type: 'boolean', default: true },
      },
    },
    handler: async (args) => {
      const enabled = await isSelfImprovementV2Enabled(db);
      if (!enabled) return { ok: false, reason: 'v2_not_enabled' };
      return { ok: false, reason: 'not_implemented_yet', stub: true };
    },
  };
}
