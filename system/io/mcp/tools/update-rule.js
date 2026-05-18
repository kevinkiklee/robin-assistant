import {
  approveCandidate,
  deactivateRule,
  rejectCandidate,
  setRulePriority,
} from '../../../cognition/memory/rules.js';

export function createUpdateRuleTool({ db }) {
  return {
    name: 'update_rule',
    description:
      'Update a rule or rule_candidate. action=approve/reject operates on candidates; deactivate/set_priority on rules.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        action: { type: 'string', enum: ['approve', 'reject', 'deactivate', 'set_priority'] },
        force: { type: 'boolean', default: false },
        options: {
          type: 'object',
          properties: {
            reason: { type: 'string' },
            priority: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      },
      required: ['id', 'action'],
    },
    handler: async (args) => {
      const { id, action, force = false, options = {} } = args;
      switch (action) {
        case 'approve': {
          // Taint gate: refuse to approve a candidate derived from untrusted content
          // unless the caller explicitly passes force=true.
          const [rows] = await db.query(`SELECT derived_from_trust FROM ${id}`).collect();
          const derived = rows?.[0]?.derived_from_trust;
          if (derived && derived !== 'trusted' && !force) {
            return { ok: false, reason: 'tainted_candidate', derived_from_trust: derived };
          }
          const r = await approveCandidate(db, id);
          return { ok: true, rule_id: String(r.id) };
        }
        case 'reject':
          await rejectCandidate(db, id, options.reason);
          return { ok: true };
        case 'deactivate':
          await deactivateRule(db, id);
          return { ok: true };
        case 'set_priority':
          if (!Number.isInteger(options.priority)) {
            throw new Error('options.priority required for set_priority action');
          }
          await setRulePriority(db, id, options.priority);
          return { ok: true };
        default:
          throw new Error(`unknown action: ${action}`);
      }
    },
  };
}
