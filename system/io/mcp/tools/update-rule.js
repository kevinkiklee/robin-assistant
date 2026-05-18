import { checkDurableWrite } from '../../../cognition/discretion/durable-write.js';
import {
  approveCandidate,
  deactivateRule,
  rejectCandidate,
  setRulePriority,
} from '../../../cognition/memory/rules.js';

// Safe alphabet for rule_candidates record-id suffixes (matches _entity-ref.js convention).
const CANDIDATE_ID_RE = /^rule_candidates:[A-Za-z0-9_-]+$/;

/**
 * Validate that `id` is a safe rule_candidates record reference.
 * Returns true when the id is safe to interpolate into SurrealQL.
 *
 * We validate + interpolate (rather than bind via surql/RecordId) because
 * SurrealDB record-typed columns don't compare equal when the value is bound
 * as a JS string — record-to-record comparison needs the literal form.
 * This matches the _entity-ref.js convention: validate alphabet, then interpolate.
 */
function isValidCandidateId(id) {
  if (id == null) return false;
  const s = typeof id === 'string' ? id : String(id);
  return CANDIDATE_ID_RE.test(s);
}

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
          // Defense-in-depth: validate id before any DB interaction so a
          // malicious id string cannot smuggle SurrealQL via interpolation.
          if (!isValidCandidateId(id)) return { ok: false, reason: 'invalid_id' };
          const safeId = typeof id === 'string' ? id : String(id);

          // Taint gate: refuse to approve a candidate derived from untrusted content
          // unless the caller explicitly passes force=true.
          // safeId is safe to interpolate — validated against CANDIDATE_ID_RE above.
          const [rows] = await db.query(`SELECT derived_from_trust FROM ${safeId}`).collect();
          const derived = rows?.[0]?.derived_from_trust;
          if (derived && derived !== 'trusted' && !force) {
            return { ok: false, reason: 'tainted_candidate', derived_from_trust: derived };
          }
          // Durable-write gate: PII/secret/verbatim on the reason text (taint NOT applied).
          const gate = await checkDurableWrite(db, {
            destination: 'update_rule',
            text: options.reason ?? '',
            sessionTaint: null,
            force,
          });
          if (!gate.ok) {
            return { ok: false, reason: 'outbound_blocked', blocked_by: gate.reason };
          }
          const r = await approveCandidate(db, safeId);
          return { ok: true, rule_id: String(r.id) };
        }
        case 'reject': {
          const rejectGate = await checkDurableWrite(db, {
            destination: 'update_rule',
            text: options.reason ?? '',
            sessionTaint: null,
            force,
          });
          if (!rejectGate.ok) {
            return { ok: false, reason: 'outbound_blocked', blocked_by: rejectGate.reason };
          }
          await rejectCandidate(db, id, options.reason);
          return { ok: true };
        }
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
