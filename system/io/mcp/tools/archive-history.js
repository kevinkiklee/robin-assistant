// archive-history.js — Theme 4.
import { BoundQuery, RecordId } from 'surrealdb';
import { wrapUntrusted } from '../../../cognition/discretion/wrap-untrusted.js';
import { markTainted } from '../../../runtime/mcp/session-taint.js';

// Wrap any user-supplied reason text in an archive_log row.
function wrapArchiveRow(row) {
  if (!row?.reason) return row;
  return {
    ...row,
    reason: wrapUntrusted(String(row.reason), {
      source: 'archive_log',
      eventId: String(row.memo_id ?? ''),
      trust: 'untrusted',
    }),
  };
}

export function createArchiveHistoryTool({ db, getSessionId }) {
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
      const sessionId = getSessionId?.() ?? null;
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
      const wrapped = (rows ?? []).map(wrapArchiveRow);
      // archive_log reason text is unconditionally untrusted — mark taint for any row returned.
      for (const row of wrapped) {
        if (row.reason != null) markTainted(sessionId, String(row.memo_id ?? ''));
      }
      return { history: wrapped };
    },
  };
}
