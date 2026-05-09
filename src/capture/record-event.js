import { surql } from 'surrealdb';
import { sha256 } from '../embed/hash.js';

const VALID_SOURCES = new Set([
  'cli',
  'stop_hook',
  'manual',
  'sync',
  'biographer',
  'ingest',
  'discord',
  'migration',
]);

export async function recordEvent(db, embedder, input) {
  const { source, content, ts, meta } = input;
  if (!VALID_SOURCES.has(source)) {
    throw new Error(`recordEvent: unknown source "${source}"`);
  }
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error('recordEvent: content must be a non-empty string');
  }

  const content_hash = sha256(content);

  // Cache lookup: if we already embedded this exact content, reuse the vector.
  const [hit] = await db
    .query(surql`SELECT VALUE embedding FROM events WHERE content_hash = ${content_hash} LIMIT 1`)
    .collect();
  let embedding;
  if (hit && hit.length > 0) {
    embedding = hit[0];
  } else {
    embedding = Array.from(await embedder.embed(content));
  }

  const tsValue = ts ? new Date(ts) : undefined;

  const set = {
    source,
    content,
    content_hash,
    embedding,
    ...(tsValue ? { ts: tsValue } : {}),
    ...(meta ? { meta } : {}),
  };

  const [created] = await db.query(surql`CREATE events CONTENT ${set}`).collect();
  const row = Array.isArray(created) ? created[0] : created;
  return { id: row.id };
}
