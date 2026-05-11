// src/mcp/tools/check-action.js
import { checkActionTrust } from '../../jobs/action-trust.js';

export function createCheckActionTool({ db }) {
  return {
    name: 'check_action',
    description:
      'Read the trust state of a (tool, action) class. Auto-creates with state ASK on first sight. Read-only otherwise.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string' },
        action: { type: 'string' },
      },
      required: ['tool', 'action'],
    },
    handler: async ({ tool, action }) => {
      const row = await checkActionTrust(db, tool, action);
      return {
        class: row.class,
        state: row.state,
        set_by: row.set_by,
        success_count: row.success_count ?? 0,
        correction_count: row.correction_count ?? 0,
        last_used_at: row.last_used_at ?? null,
        last_state_change_at: row.last_state_change_at,
      };
    },
  };
}
