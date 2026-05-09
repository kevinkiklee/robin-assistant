import { surql } from 'surrealdb';
import { recall as internalRecall } from '../../recall/index.js';

export function createRecallTool({ db, embedder, detector, getSessionId }) {
  return {
    name: 'recall',
    description:
      "Search the user's memory by semantic similarity. Returns events that match the query, with mention-edge enrichment. Call mark_recall_used afterwards with the IDs of hits that informed your answer.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 500 },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        source: {
          type: 'string',
          enum: [
            'cli',
            'stop_hook',
            'manual',
            'sync',
            'biographer',
            'ingest',
            'discord',
            'migration',
          ],
        },
        since: { type: 'string', format: 'date-time' },
        until: { type: 'string', format: 'date-time' },
        explain: { type: 'boolean', default: false },
      },
      required: ['query'],
    },
    handler: async (args) => {
      const sessionId = getSessionId() ?? null;
      const queryVec = Array.from(await embedder.embed(args.query));

      const repeat = detector.check(sessionId, queryVec).repeat;
      detector.observe(sessionId, queryVec);

      const r = await internalRecall(db, embedder, args.query, {
        limit: args.limit,
        source: args.source,
        since: args.since,
        until: args.until,
        explain: args.explain,
      });

      const hitIds = r.hits.map((h) => h.id);
      const hitDists = r.hits.map((h) => h.dist);

      const meta = repeat ? { repeat_query_within_5min: true } : undefined;
      const [created] = await db
        .query(
          surql`CREATE recall_events CONTENT ${{
            query_text: args.query,
            query_vec: queryVec,
            hit_ids: hitIds,
            hit_dists: hitDists,
            hit_used: hitIds.map(() => false),
            session_id: sessionId,
            meta,
          }}`,
        )
        .collect();
      const recallEventId = (Array.isArray(created) ? created[0] : created).id;

      const enrichedHits = [];
      for (const hit of r.hits) {
        const [mentions] = await db
          .query(surql`SELECT ->mentions->entities AS m FROM ${hit.id}`)
          .collect();
        const m = mentions[0]?.m ?? [];
        let details = [];
        if (m.length > 0) {
          const [d] = await db
            .query(surql`SELECT id, name, type FROM entities WHERE id IN ${m}`)
            .collect();
          details = d;
        }
        enrichedHits.push({
          id: String(hit.id),
          source: hit.source,
          content: hit.content,
          ts: hit.ts,
          dist: hit.dist,
          mentions: details.map((d) => ({
            entity_id: String(d.id),
            entity_name: d.name,
            entity_type: d.type,
          })),
        });
      }

      return {
        recall_event_id: String(recallEventId),
        hits: enrichedHits,
        ...(r.explain ? { explain: r.explain } : {}),
      };
    },
  };
}
