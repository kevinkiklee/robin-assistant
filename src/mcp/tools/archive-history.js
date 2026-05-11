// archive-history.js — Theme 4.
import { BoundQuery, RecordId } from 'surrealdb';

export function createArchiveHistoryTool({ db }) {
  return {
    name: 'archive_history',
    description: 'Audit trail of archive / restore events for memos.',
    inputSchema: {
      type: 'object',
      properties: {
        memo_id: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
      },
    },
    handler: async ({ memo_id, limit = 100 }) => {
      let rows;
      if (memo_id) {
        const id = memo_id.startsWith('memos:')
          ? new RecordId('memos', memo_id.slice('memos:'.length))
          : memo_id.startsWith('archive_memos:')
            ? new RecordId('archive_memos', memo_id.slice('archive_memos:'.length))
            : new RecordId('memos', memo_id);
        const [r] = await db
          .query(
            new BoundQuery(
              'SELECT memo_id, action, reason, ts FROM archive_log WHERE memo_id = $id ORDER BY ts DESC LIMIT $l',
              { id, l: limit },
            ),
          )
          .collect();
        rows = r;
      } else {
        const [r] = await db
          .query(
            new BoundQuery(
              'SELECT memo_id, action, reason, ts FROM archive_log ORDER BY ts DESC LIMIT $l',
              { l: limit },
            ),
          )
          .collect();
        rows = r;
      }
      return { history: rows ?? [] };
    },
  };
}
