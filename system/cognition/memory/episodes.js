import { surql } from 'surrealdb';
import { toRecordRef } from '../../data/db/record-ref.js';

export async function findActiveEpisode(db, source) {
  const [rows] = await db
    .query(surql`SELECT * FROM episodes WHERE source = ${source} AND ended_at IS NONE LIMIT 1`)
    .collect();
  return rows.length === 0 ? null : rows[0];
}

export async function createEpisode(db, { source, summary }) {
  if (typeof source !== 'string' || source.length === 0) {
    throw new Error(
      `createEpisode: source must be a non-empty string (got ${typeof source}: ${JSON.stringify(source)})`,
    );
  }
  const fields = { source, ...(summary ? { summary } : {}) };
  const [created] = await db.query(surql`CREATE episodes CONTENT ${fields}`).collect();
  const row = Array.isArray(created) ? created[0] : created;
  return { id: row.id };
}

export async function closeEpisode(db, episodeId, { endedAt, summary }) {
  const set = {
    ended_at: endedAt ?? new Date(),
    ...(summary !== undefined ? { summary } : {}),
  };
  await db.query(surql`UPDATE ${toRecordRef(episodeId)} MERGE ${set}`).collect();
}
