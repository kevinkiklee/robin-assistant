import { BoundQuery, surql } from 'surrealdb';
import { sha256 } from '../../../data/embed/hash.js';
import { activeProfile, embeddingTable } from '../../../data/embed/profile-router.js';

function sanitizeIdPart(s) {
  return /^[a-zA-Z0-9_-]+$/.test(s) ? s : `h_${Buffer.from(s).toString('hex').slice(0, 16)}`;
}

function deterministicId(source, external_id) {
  return `${source}__${sanitizeIdPart(external_id)}`;
}

async function writeEventEmbedding(db, embedder, eventId, content) {
  const profile = await activeProfile(db);
  const table = embeddingTable(profile, 'events');
  const vec = Array.from(await embedder.embed(content));
  await db
    .query(
      new BoundQuery(
        'UPSERT type::record($tb, [$rec]) SET record = $rec, vector = $vec, ts = time::now()',
        { tb: table, rec: eventId, vec },
      ),
    )
    .collect();
}

export function createCapture({ db, embedder, source, embed, mode }) {
  return async function capture(rows) {
    const result = { inserted: 0, skipped: 0, updated: 0, errors: [] };
    for (const row of rows) {
      try {
        const idKey = deterministicId(row.source ?? source, row.external_id);
        const tsValue = row.ts ? new Date(row.ts) : undefined;
        // The `events` schema dropped the inline `external_id` and `embedding`
        // columns in the redesign. Fold external_id into meta; write the
        // vector into embeddings_<profile>_events instead.
        const mergedMeta = { ...(row.meta ?? {}), external_id: row.external_id };
        const fields = {
          source: row.source ?? source,
          content: row.content,
          content_hash: sha256(row.content),
          trust: row.trust ?? 'trusted',
          meta: mergedMeta,
          ...(tsValue ? { ts: tsValue } : {}),
        };
        let eventId;
        let didWrite = false;
        if (mode === 'upsert') {
          const [ret] = await db
            .query(surql`UPSERT type::record('events', ${idKey}) MERGE ${fields}`)
            .collect();
          const r = Array.isArray(ret) ? ret[0] : ret;
          eventId = r?.id;
          result.updated += 1;
          didWrite = true;
        } else {
          const [exists] = await db
            .query(surql`SELECT id FROM type::record('events', ${idKey})`)
            .collect();
          if (exists.length > 0) {
            result.skipped += 1;
            continue;
          }
          const [ret] = await db
            .query(surql`CREATE type::record('events', ${idKey}) CONTENT ${fields}`)
            .collect();
          const r = Array.isArray(ret) ? ret[0] : ret;
          eventId = r?.id;
          result.inserted += 1;
          didWrite = true;
        }
        if (didWrite && embed && eventId) {
          try {
            await writeEventEmbedding(db, embedder, eventId, row.content);
          } catch (e) {
            console.warn(`capture: embedding failed for ${idKey}: ${e.message}`);
          }
        }
      } catch (e) {
        result.errors.push({ external_id: row.external_id, error: e.message });
      }
    }
    return result;
  };
}
