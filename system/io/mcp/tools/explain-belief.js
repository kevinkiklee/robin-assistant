// explain-belief.js — Theme 4. Why does Robin believe this memo at this confidence?
import { BoundQuery, RecordId } from 'surrealdb';
import { isOutboundBlocked } from '../../../cognition/memory/scope-registry.js';

export function createExplainBeliefTool({ db }) {
  return {
    name: 'explain_belief',
    description:
      'For a memo, show how its confidence got to its current value: evidence ledger, supersedes/contradicts edges, derivation formula.',
    inputSchema: {
      type: 'object',
      properties: { memo_id: { type: 'string', minLength: 1 } },
      required: ['memo_id'],
    },
    handler: async ({ memo_id }) => {
      const id = memo_id.startsWith('memos:')
        ? new RecordId('memos', memo_id.slice('memos:'.length))
        : new RecordId('memos', memo_id);
      const [memoRows] = await db.query(new BoundQuery('SELECT * FROM ONLY $id', { id })).collect();
      const m = memoRows?.[0] ?? memoRows;
      if (!m?.id) return { error: 'not_found' };
      const redacted = isOutboundBlocked(m.scope);
      const [evidence] = await db
        .query(
          new BoundQuery(
            'SELECT polarity, reason, weight, ts FROM evidence_ledger WHERE memo_id = $id ORDER BY ts ASC',
            { id },
          ),
        )
        .collect();
      const [edges] = await db
        .query(
          new BoundQuery(
            "SELECT kind, in, out FROM edges WHERE (in = $id OR out = $id) AND kind IN ['supersedes', 'contradicts']",
            { id },
          ),
        )
        .collect();
      let derived = null;
      try {
        const [d] = await db
          .query(new BoundQuery('SELECT VALUE fn::derived_confidence($id) FROM ONLY $id', { id }))
          .collect();
        derived = d?.[0] ?? null;
      } catch {}
      return {
        memo_id: String(m.id),
        kind: m.kind,
        content: redacted ? '<redacted: private scope>' : m.content,
        confidence_stored: m.confidence,
        derived_confidence: derived,
        signal_count: m.signal_count,
        evidence: evidence ?? [],
        edges: edges ?? [],
        formula:
          '(initial × prior_weight + Σcor_weight) / (prior_weight + Σcor_weight + Σref_weight)',
      };
    },
  };
}
