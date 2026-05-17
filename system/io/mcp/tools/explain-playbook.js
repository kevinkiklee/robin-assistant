import { isSelfImprovementV2Enabled } from '../../../runtime/config/self-improvement-v2.js';

export function createExplainPlaybookTool({ db }) {
  return {
    name: 'explain_playbook',
    description:
      'Explain why a playbook was synthesized: shows the source task_outcome memos, which dream step produced it, and how the step-by-step content was derived from observed signals.',
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
