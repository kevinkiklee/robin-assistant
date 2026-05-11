// attention.js — what Robin is currently attending to.
// Spec §5 / module-rename from hot.js. Returns active episodes + recent events
// + entities surfaced via `about`/`mentions` edges across the recent set.

import { BoundQuery, surql } from 'surrealdb';

const DEFAULT_WINDOW_MIN = 30;
const MAX_WINDOW_MIN = 10080; // 7d

export async function getAttention(db, { source, windowMinutes = DEFAULT_WINDOW_MIN } = {}) {
  if (!Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > MAX_WINDOW_MIN) {
    throw new Error(
      `getAttention: windowMinutes out of range [1,${MAX_WINDOW_MIN}]: ${windowMinutes}`,
    );
  }

  // 1. Active episodes (filtered by source if provided).
  let episodes;
  if (source != null) {
    const [rows] = await db
      .query(
        surql`SELECT id, source, started_at, summary FROM episodes
              WHERE ended_at IS NONE AND source = ${source}
              ORDER BY started_at DESC LIMIT 5`,
      )
      .collect();
    episodes = rows;
  } else {
    const [rows] = await db
      .query(
        surql`SELECT id, source, started_at, summary FROM episodes
              WHERE ended_at IS NONE
              ORDER BY started_at DESC LIMIT 5`,
      )
      .collect();
    episodes = rows;
  }

  if (episodes.length === 0) {
    return { episodes: [], recent_events: [], entities: [] };
  }

  // 2. Recent events tied to those episodes.
  const epIds = episodes.map((e) => e.id);
  const cutoff = new Date(Date.now() - windowMinutes * 60_000);
  const eventsSql = `
    SELECT id, source, content, ts, episode_id
    FROM events
    WHERE episode_id IN $epIds AND ts >= $cutoff
    ORDER BY ts DESC
    LIMIT 30
  `;
  const [recent_events] = await db
    .query(new BoundQuery(eventsSql, { epIds, cutoff }))
    .collect();

  // 3. Entities mentioned in those recent events (via mentions/about edges).
  const eventIds = recent_events.map((e) => e.id);
  let entities = [];
  if (eventIds.length > 0) {
    const entSql = `
      SELECT DISTINCT to AS entity, kind FROM edges
      WHERE kind IN ['mentions', 'about'] AND from IN $eids
      LIMIT 50
    `;
    const [rows] = await db.query(new BoundQuery(entSql, { eids: eventIds })).collect();
    // Hydrate entity names
    if (rows.length > 0) {
      const ids = rows.map((r) => r.entity);
      const [hydrated] = await db
        .query(new BoundQuery('SELECT id, name, type FROM entities WHERE id IN $ids', { ids }))
        .collect();
      entities = hydrated;
    }
  }

  return { episodes, recent_events, entities };
}

// Legacy alias for backward compatibility during migration.
export const getHotContext = getAttention;
