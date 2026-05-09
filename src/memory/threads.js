import { BoundQuery, surql } from 'surrealdb';

/**
 * Threads — groupings of related episodes (e.g. "Atlas project work" spanning
 * multiple episodes over several days). Created by the dream pipeline.
 *
 * `episode_ids` and `entity_ids` are required arrays (schema is `array<record<...>>`,
 * not `option<...>`) — pass `[]` when none apply.
 */
export async function createThread(db, input) {
  const { title, episode_ids, entity_ids, summary, meta } = input;
  const fields = {
    episode_ids,
    entity_ids,
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
    ...(meta ? { meta } : {}),
  };
  const [created] = await db.query(surql`CREATE threads CONTENT ${fields}`).collect();
  const row = Array.isArray(created) ? created[0] : created;
  return { id: row.id };
}

export async function listThreads(db, { since, limit = 20 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error(`listThreads: limit out of range [1,1000]: ${limit}`);
  }
  if (since) {
    const sql = `SELECT id, title, started_at, last_active, episode_ids, entity_ids, summary FROM threads WHERE last_active >= $since ORDER BY last_active DESC LIMIT ${limit}`;
    const [rows] = await db.query(new BoundQuery(sql, { since: new Date(since) })).collect();
    return rows;
  }
  const sql = `SELECT id, title, started_at, last_active, episode_ids, entity_ids, summary FROM threads ORDER BY last_active DESC LIMIT ${limit}`;
  const [rows] = await db.query(sql).collect();
  return rows;
}
