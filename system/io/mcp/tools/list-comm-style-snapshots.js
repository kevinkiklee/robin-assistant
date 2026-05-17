import { isSelfImprovementV2Enabled } from '../../../runtime/config/self-improvement-v2.js';

export function createListCommStyleSnapshotsTool({ db }) {
  return {
    name: 'list_comm_style_snapshots',
    description:
      "List historical comm_style_snapshot memos in reverse chronological order. Each snapshot records the synthesized communication-style preferences at a point in time, enabling trend inspection.",
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
    },
    handler: async (args) => {
      const enabled = await isSelfImprovementV2Enabled(db);
      if (!enabled) return { ok: false, reason: 'v2_not_enabled' };
      return { ok: false, reason: 'not_implemented_yet', stub: true };
    },
  };
}
