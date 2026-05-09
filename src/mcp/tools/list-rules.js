import { listCandidates } from '../../rules/candidates.js';
import { listRules } from '../../rules/rules.js';

export function createListRulesTool({ db }) {
  return {
    name: 'list_rules',
    description:
      'List rules. status="active" returns approved active rules; "pending" returns rule_candidates awaiting review; "all" returns both.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'active', 'all'], default: 'active' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
      },
    },
    handler: async (args = {}) => {
      const status = args.status ?? 'active';
      const limit = args.limit ?? 50;
      const out = {};
      if (status === 'active' || status === 'all') {
        const rules = await listRules(db, { activeOnly: true, limit });
        out.active = rules.map((r) => ({
          ...r,
          id: String(r.id),
          source_candidate: r.source_candidate ? String(r.source_candidate) : null,
        }));
      }
      if (status === 'pending' || status === 'all') {
        const cands = await listCandidates(db, { status: 'pending', limit });
        out.pending = cands.map((c) => ({
          ...c,
          id: String(c.id),
          signal_events: (c.signal_events ?? []).map(String),
        }));
      }
      return out;
    },
  };
}
