// refute.js — manual refutation ledger row. Theme 2a.

import { RecordId } from 'surrealdb';
import { addEvidence, readEvidenceConfig } from '../../../cognition/memory/evidence.js';

export function createRefuteTool({ db }) {
  return {
    name: 'refute',
    description:
      'Add a negative evidence signal for a memo. Lowers its derived confidence over time.',
    inputSchema: {
      type: 'object',
      properties: {
        memo_id: { type: 'string', description: 'memos:<id>' },
        reason: { type: 'string', maxLength: 200 },
      },
      required: ['memo_id'],
    },
    handler: async ({ memo_id, reason }) => {
      const cfg = await readEvidenceConfig(db);
      const id = memo_id.startsWith('memos:')
        ? new RecordId('memos', memo_id.slice('memos:'.length))
        : new RecordId('memos', memo_id);
      await addEvidence(db, {
        memo_id: id,
        polarity: 'refutes',
        reason: reason ?? 'manual',
        weight: cfg.manual_weight ?? 2.0,
      });
      return { ok: true };
    },
  };
}
