// step-threads.js — narrative arc construction from edges[kind='mentions'].
//
// Finds entities mentioned across 2+ episodes within recencyDays and creates
// one memo[kind='thread'] per qualifying entity grouping.

import { BoundQuery, surql } from 'surrealdb';
import { add as narrativeAdd } from '../memory/narrative.js';

const DEFAULT_RECENCY_DAYS = 7;

export async function dreamStepThreads(db, opts = {}) {
  const { recencyDays = DEFAULT_RECENCY_DAYS, embedder = null } = opts;
  const cutoff = new Date(Date.now() - recencyDays * 86400_000);

  // 1. Recent episode-bound events.
  const [eventIds] = await db
    .query(
      surql`SELECT VALUE id FROM events
            WHERE ts >= ${cutoff} AND episode_id IS NOT NONE`,
    )
    .collect();
  if (!eventIds || eventIds.length === 0) return { created: 0 };

  // 2. Mentions edges from those events to entities.
  // edges.kind = 'mentions'; from = events; to = entities
  const sql = `
    SELECT from, to FROM edges
    WHERE kind = 'mentions' AND from IN $eids
  `;
  const [edges] = await db
    .query(new BoundQuery(sql, { eids: eventIds }))
    .collect();
  if (!edges || edges.length === 0) return { created: 0 };

  // 3. Hydrate episode_id per event (single batched query).
  const evSql = `SELECT id, episode_id FROM events WHERE id IN $eids`;
  const [evRows] = await db.query(new BoundQuery(evSql, { eids: eventIds })).collect();
  const episodeByEvent = new Map();
  for (const r of evRows ?? []) {
    episodeByEvent.set(String(r.id), r.episode_id);
  }

  // 4. Group by entity → set of distinct episode IDs.
  const byEntity = new Map();
  for (const edge of edges) {
    const evId = String(edge.from);
    const epId = episodeByEvent.get(evId);
    if (!epId) continue;
    const key = String(edge.to);
    if (!byEntity.has(key)) byEntity.set(key, { entity: edge.to, episodes: new Set() });
    byEntity.get(key).episodes.add(String(epId));
  }

  let created = 0;
  for (const { entity, episodes } of byEntity.values()) {
    if (episodes.size < 2) continue;
    if (!embedder) continue;
    await narrativeAdd(db, embedder, {
      title: null,
      summary: `Narrative arc involving ${entity} across ${episodes.size} episodes.`,
      episode_ids: Array.from(episodes),
      entity_ids: [entity],
    });
    created++;
  }
  return { created };
}
