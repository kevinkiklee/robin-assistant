// step-arcs.js — Theme 1b. Cluster recent episodes by shared participating
// entities; create or extend arcs via Jaccard dedup. Replaces step-threads
// (which wrote kind='thread' memos).

import { BoundQuery, surql } from 'surrealdb';
import { createArc, extendArc, jaccard, readArcConfig } from '../memory/arcs.js';

const DEFAULT_RECENCY_DAYS = 7;

export async function dreamStepArcs(db, opts = {}) {
  const { recencyDays = DEFAULT_RECENCY_DAYS } = opts;
  const cfg = await readArcConfig(db);
  if (!cfg.auto_create_enabled) return { created: 0, extended: 0 };

  const cutoff = new Date(Date.now() - recencyDays * 86_400_000);

  // 1. Recent closed episodes with last_event_at within the window.
  const [eps] = await db
    .query(
      surql`SELECT id, source, started_at, ended_at, last_event_at
            FROM episodes
            WHERE (ended_at >= ${cutoff} OR last_event_at >= ${cutoff})`,
    )
    .collect();
  if (!eps?.length) return { created: 0, extended: 0 };
  const episodeIds = eps.map((e) => e.id);

  // 2. Pull mentions edges from events in those episodes.
  const [eventRows] = await db
    .query(
      new BoundQuery(`SELECT id, episode_id FROM events WHERE episode_id IN $eids`, {
        eids: episodeIds,
      }),
    )
    .collect();
  if (!eventRows?.length) return { created: 0, extended: 0 };
  const eventToEp = new Map();
  for (const r of eventRows) eventToEp.set(String(r.id), r.episode_id);
  const eventIds = eventRows.map((r) => r.id);

  const [edges] = await db
    .query(
      new BoundQuery(`SELECT in, out FROM edges WHERE kind = 'mentions' AND in IN $eids`, {
        eids: eventIds,
      }),
    )
    .collect();

  // 3. Group entities per episode and across the window.
  const entitiesByEpisode = new Map();
  for (const e of edges ?? []) {
    const epId = eventToEp.get(String(e.in));
    if (!epId) continue;
    const key = String(epId);
    if (!entitiesByEpisode.has(key)) entitiesByEpisode.set(key, new Set());
    entitiesByEpisode.get(key).add(String(e.out));
  }

  // 4. Cluster episodes that share ≥ min_shared_entities.
  const clusters = [];
  const visited = new Set();
  const epEntries = [...entitiesByEpisode.entries()];
  for (let i = 0; i < epEntries.length; i++) {
    const [epA, entsA] = epEntries[i];
    if (visited.has(epA)) continue;
    const cluster = { episodes: [epA], entities: new Set(entsA) };
    visited.add(epA);
    for (let j = i + 1; j < epEntries.length; j++) {
      const [epB, entsB] = epEntries[j];
      if (visited.has(epB)) continue;
      let shared = 0;
      for (const x of entsB) if (cluster.entities.has(x)) shared++;
      if (shared >= cfg.min_shared_entities) {
        cluster.episodes.push(epB);
        for (const x of entsB) cluster.entities.add(x);
        visited.add(epB);
      }
    }
    if (cluster.episodes.length >= cfg.min_episodes) clusters.push(cluster);
  }
  if (clusters.length === 0) return { created: 0, extended: 0 };

  // 5. For each cluster, dedup against existing active|paused arcs by Jaccard.
  const [existing] = await db
    .query(surql`SELECT id, entity_ids FROM arcs WHERE status IN ['active', 'paused']`)
    .collect();

  let created = 0;
  let extended = 0;
  for (const c of clusters) {
    const clusterEntityIds = [...c.entities];
    let bestMatch = null;
    let bestScore = 0;
    for (const arc of existing ?? []) {
      const arcEntityIds = (arc.entity_ids ?? []).map(String);
      const j = jaccard(arcEntityIds, clusterEntityIds);
      if (j >= cfg.dedup_jaccard_threshold && j > bestScore) {
        bestMatch = arc;
        bestScore = j;
      }
    }
    // Get episode record refs from string ids
    const epRecords = eps.filter((e) => c.episodes.includes(String(e.id))).map((e) => e.id);
    const entityRecords = (edges ?? [])
      .filter((e) => c.entities.has(String(e.out)))
      .map((e) => e.out);
    const uniqEntities = [];
    const seen = new Set();
    for (const r of entityRecords) {
      const k = String(r);
      if (!seen.has(k)) {
        seen.add(k);
        uniqEntities.push(r);
      }
    }
    if (bestMatch) {
      await extendArc(db, bestMatch.id, {
        entity_ids: uniqEntities,
        episode_ids: epRecords,
      });
      extended++;
    } else {
      const summary = `Activity arc across ${c.episodes.length} episodes involving ${uniqEntities.length} entities.`;
      const arc = await createArc(db, {
        summary,
        entity_ids: uniqEntities,
        meta: { episode_ids: epRecords.map(String) },
      });
      if (arc?.id) created++;
    }
  }

  // 6. State transitions: active → paused → closed by idle time.
  try {
    const pauseDate = new Date(Date.now() - cfg.pause_after_idle_days * 86_400_000);
    await db
      .query(
        surql`UPDATE arcs SET status = 'paused'
              WHERE status = 'active' AND last_activity_at < ${pauseDate}`,
      )
      .collect();
    const closeDate = new Date(Date.now() - cfg.close_after_idle_days * 86_400_000);
    await db
      .query(
        surql`UPDATE arcs SET status = 'closed', ended_at = time::now()
              WHERE status = 'paused' AND last_activity_at < ${closeDate}`,
      )
      .collect();
  } catch (e) {
    console.warn(`[step-arcs transitions] ${e.message}`);
  }

  return { created, extended };
}
