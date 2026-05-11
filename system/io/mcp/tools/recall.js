import { surql } from 'surrealdb';
import { recall as internalRecall } from '../../../cognition/intuition/engine.js';

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
        scope_descends_from: { type: 'string', minLength: 1, maxLength: 200 },
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
        scope_descends_from: args.scope_descends_from,
      });

      // Batch mention + entity-detail lookups across all hits using the
      // generic `edges` table (post-redesign schema; arrow-graph syntax
      // `->mentions->entities` does NOT traverse TYPE NORMAL tables). Two
      // queries total instead of 2N: one SELECT against edges keyed by hit
      // IDs, one SELECT to hydrate the distinct entity rows.
      const hitIds = r.hits.map((h) => h.id);
      const enrichedHits = [];
      if (hitIds.length > 0) {
        const [edgeRows] = await db
          .query(surql`SELECT in, out FROM edges WHERE kind = 'mentions' AND in IN ${hitIds}`)
          .collect();
        // mentionsByHit keys are stringified record IDs (we look up by
        // String(hit.id)); but for the second SELECT we keep the raw record
        // IDs because SurrealDB compares `id IN $x` by record type, not by
        // string equality.
        const mentionsByHit = new Map();
        const entityIdSet = new Set(); // for de-duping
        const entityIdList = []; // raw RecordIds for the IN query
        for (const e of edgeRows ?? []) {
          const fromId = String(e.in);
          const toIdStr = String(e.out);
          if (!mentionsByHit.has(fromId)) mentionsByHit.set(fromId, []);
          mentionsByHit.get(fromId).push(toIdStr);
          if (!entityIdSet.has(toIdStr)) {
            entityIdSet.add(toIdStr);
            entityIdList.push(e.out);
          }
        }
        let entityById = new Map();
        if (entityIdList.length > 0) {
          const [details] = await db
            .query(surql`SELECT id, name, type FROM entities WHERE id IN ${entityIdList}`)
            .collect();
          entityById = new Map((details ?? []).map((d) => [String(d.id), d]));
        }
        for (const hit of r.hits) {
          const mIds = mentionsByHit.get(String(hit.id)) ?? [];
          const mentions = mIds
            .map((eid) => entityById.get(eid))
            .filter(Boolean)
            .map((d) => ({
              entity_id: String(d.id),
              entity_name: d.name,
              entity_type: d.type,
            }));
          enrichedHits.push({
            id: String(hit.id),
            source: hit.source,
            content: hit.content,
            ts: hit.ts,
            dist: hit.dist,
            mentions,
          });
        }
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
