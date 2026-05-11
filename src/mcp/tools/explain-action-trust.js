// explain-action-trust.js — Theme 4. State + ledger history for a tool:action class.
import { surql } from 'surrealdb';

export function createExplainActionTrustTool({ db }) {
  return {
    name: 'explain_action_trust',
    description: 'Return current state + full ledger history for a (tool:action) class.',
    inputSchema: {
      type: 'object',
      properties: { class: { type: 'string', pattern: '^[a-z_]+:[a-z_-]+$' } },
      required: ['class'],
    },
    handler: async ({ class: cls }) => {
      const [cur] = await db
        .query(surql`SELECT * FROM action_trust WHERE class = ${cls}`)
        .collect();
      const [hist] = await db
        .query(
          surql`SELECT kind, old_state, new_state, set_by, reason, ts
                FROM action_trust_ledger
                WHERE class = ${cls}
                ORDER BY ts ASC`,
        )
        .collect();
      return { current: cur?.[0] ?? null, history: hist ?? [] };
    },
  };
}
