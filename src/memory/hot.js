import { BoundQuery, surql } from 'surrealdb';

/**
 * Hot context — the "what's happening right now" bundle: open episodes and
 * the recent events tied to them.
 *
 * - Episodes are "active" when `ended_at IS NONE`. Optionally filter by
 *   `source` (e.g. only the cli session). Capped at 5 most-recent.
 * - "Recent events" means events whose `episode_id` is in the active set AND
 *   whose `ts` is within the last `windowMinutes` (default 30).
 * - `entities` is reserved for future enrichment (entity-graph touch points
 *   for the active episodes); it returns `[]` until that lands.
 *
 * `episode_id IN $epIds` works against an array of record IDs in SurrealDB v3.
 */
export async function getHotContext(db, { source, windowMinutes = 30 } = {}) {
  if (!Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 10080) {
    throw new Error(`getHotContext: windowMinutes out of range [1,10080]: ${windowMinutes}`);
  }

  // 1. Active episodes.
  let episodes;
  if (source != null) {
    const [rows] = await db
      .query(
        surql`SELECT id, source, started_at, summary FROM episodes WHERE ended_at IS NONE AND source = ${source} ORDER BY started_at DESC LIMIT 5`,
      )
      .collect();
    episodes = rows;
  } else {
    const [rows] = await db
      .query(
        surql`SELECT id, source, started_at, summary FROM episodes WHERE ended_at IS NONE ORDER BY started_at DESC LIMIT 5`,
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
  const sql = `
    SELECT id, source, content, ts, episode_id
    FROM events
    WHERE episode_id IN $epIds AND ts >= $cutoff
    ORDER BY ts DESC
    LIMIT 30
  `;
  const [recent_events] = await db.query(new BoundQuery(sql, { epIds, cutoff })).collect();

  return { episodes, recent_events, entities: [] };
}
