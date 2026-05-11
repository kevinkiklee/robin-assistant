import { setActionTrust } from '../../../cognition/jobs/action-trust.js';

const VALID_STATES = new Set(['AUTO', 'ASK', 'NEVER']);
const CLASS_PATTERN = /^[a-z_]+:[a-z_-]+$/;

export function createUpdateActionPolicyTool({ db }) {
  return {
    name: 'update_action_policy',
    description:
      'Set the trust state for a (tool, action) class. Use when the user gives standing permission ("you can always X") or revokes it ("never X again").',
    inputSchema: {
      type: 'object',
      properties: {
        class: { type: 'string', pattern: '^[a-z_]+:[a-z_-]+$' },
        state: { type: 'string', enum: ['AUTO', 'ASK', 'NEVER'] },
        reason: { type: 'string', maxLength: 200 },
      },
      required: ['class', 'state'],
    },
    handler: async ({ class: cls, state, reason }) => {
      if (!CLASS_PATTERN.test(cls)) return { ok: false, reason: 'invalid_class' };
      if (!VALID_STATES.has(state)) return { ok: false, reason: 'invalid_state' };
      await setActionTrust(db, cls, state, 'user', reason);
      return { ok: true, class: cls, state };
    },
  };
}
