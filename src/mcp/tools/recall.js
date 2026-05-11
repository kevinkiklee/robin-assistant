import { surql } from 'surrealdb';
import { recall as internalRecall } from '../../recall/index.js';

export function createRecallTool({ db, embedder, detector, getSessionId }) {
  return {
    name: 'recall',
    description:
      "Search the user's memory by semantic similarity. Returns events that match the query, with mention-edge enrichment.",
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

      const rankedHits = enrichedHits.map((h, i) => ({
        record: h.id,
        kind: 'event',
        dist: h.dist,
        rank: i,
      }));
      const meta = repeat ? { repeat_query_within_5min: true } : undefined;
      try {
        await db
          .query(
            surql`CREATE recall_log CONTENT ${{
              query: args.query,
              k: args.limit ?? 10,
              ranked_hits: rankedHits,
              session_id: sessionId,
              meta,
            }}`,
          )
          .collect();
      } catch {
        // recall_log write is advisory — never fail the recall on telemetry errors.
      }

      return {
        hits: enrichedHits,
        ...(r.explain ? { explain: r.explain } : {}),
      };
    },
  };
}
