import { isSelfImprovementV2Enabled } from '../../../runtime/config/self-improvement-v2.js';

export function createRecordOutcomeTool({ db }) {
  return {
    name: 'record_outcome',
    description:
      'Record the outcome of a completed task so Robin can learn from it over time. Signals (quality, latency, user corrections) feed the introspection faculty and are synthesized into playbooks during the nightly dream cycle.',
    inputSchema: {
      type: 'object',
      properties: {
        task_type: { type: 'string', minLength: 1, maxLength: 200 },
        task_id: { type: 'string', minLength: 1, maxLength: 200 },
        signals: { type: 'object' },
        source_event: { type: 'string' },
      },
      required: ['task_type', 'task_id', 'signals'],
    },
    handler: async (args) => {
      const enabled = await isSelfImprovementV2Enabled(db);
      if (!enabled) return { ok: false, reason: 'v2_not_enabled' };
      return { ok: false, reason: 'not_implemented_yet', stub: true };
    },
  };
}
