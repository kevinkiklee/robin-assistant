// explain-recall.js — Theme 4 introspection. Read-only.
import { BoundQuery, RecordId } from 'surrealdb';
import { isOutboundBlocked } from '../../../cognition/memory/scope-registry.js';
import { wrapUntrusted } from '../../../cognition/discretion/wrap-untrusted.js';

export function createExplainRecallTool({ db }) {
  return {
    name: 'explain_recall',
    description:
      'Explain how Robin ranked hits for a recall query. Returns recent recall_log rows with score components, sources, and reinforcement outcomes.',
    inputSchema: {
      type: 'object',
      properties: {
        query_id: { type: 'string', description: 'recall_log:<id> — omit for most recent' },
        last_n: { type: 'integer', minimum: 1, maximum: 20, default: 1 },
      },
    },
    handler: async ({ query_id, last_n = 1 }) => {
      let rowsRaw;
      if (query_id) {
        const id = query_id.startsWith('recall_log:')
          ? new RecordId('recall_log', query_id.slice('recall_log:'.length))
          : new RecordId('recall_log', query_id);
        const [r] = await db.query(new BoundQuery('SELECT * FROM $id', { id })).collect();
        rowsRaw = r ?? [];
      } else {
        const [r] = await db
          .query(
            new BoundQuery('SELECT * FROM recall_log ORDER BY ts DESC LIMIT $n', { n: last_n }),
          )
          .collect();
        rowsRaw = r ?? [];
      }
      const queries = [];
      for (const row of rowsRaw) {
        // hydrate hit scopes; redact private-scope hits
        const hits = [];
        for (const h of row.ranked_hits ?? []) {
          const rid = h.record ?? h.memo_id ?? h.event_id ?? h.record_id;
          if (!rid) continue;
          try {
            const [m] = await db
              .query(new BoundQuery('SELECT id, scope FROM ONLY $id', { id: rid }))
              .collect();
            const r0 = m?.[0] ?? m;
            if (r0?.scope && isOutboundBlocked(r0.scope)) continue;
            hits.push({ ...h, scope: r0?.scope ?? 'unknown' });
          } catch {
            hits.push(h);
          }
        }
        queries.push({
          query_id: String(row.id),
          ts: row.ts,
          query: row.query,
          outcome: row.outcome,
          attribution: row.attribution ?? null,
          reply_event_id: row.reply_event_id ?? null,
          ranked_hits: hits,
        });
      }
      return { queries };
    },
  };
}
