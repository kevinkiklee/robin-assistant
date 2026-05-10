import { surql } from 'surrealdb';
import { sha256 } from '../../embed/hash.js';

function sanitizeIdPart(s) {
  return /^[a-zA-Z0-9_-]+$/.test(s) ? s : `h_${Buffer.from(s).toString('hex').slice(0, 16)}`;
}

function deterministicId(source, external_id) {
  return `${source}__${sanitizeIdPart(external_id)}`;
}

export function createCapture({ db, embedder, source, embed, mode }) {
  return async function capture(rows) {
    const result = { inserted: 0, skipped: 0, updated: 0, errors: [] };
    for (const row of rows) {
      try {
        const idKey = deterministicId(row.source ?? source, row.external_id);
        let embedding = null;
        if (embed) {
          try {
            embedding = Array.from(await embedder.embed(row.content));
          } catch (e) {
            console.warn(`capture: embedding failed for ${idKey}, writing NULL: ${e.message}`);
          }
        }
        const tsValue = row.ts ? new Date(row.ts) : undefined;
        const fields = {
          source: row.source ?? source,
          content: row.content,
          content_hash: sha256(row.content),
          external_id: row.external_id,
          trust: row.trust ?? 'trusted',
          meta: row.meta ?? {},
          ...(tsValue ? { ts: tsValue } : {}),
          ...(embedding ? { embedding } : {}),
        };
        if (mode === 'upsert') {
          await db.query(surql`UPSERT type::record('events', ${idKey}) MERGE ${fields}`).collect();
          result.updated += 1;
        } else {
          const [exists] = await db
            .query(surql`SELECT id FROM type::record('events', ${idKey})`)
            .collect();
          if (exists.length > 0) {
            result.skipped += 1;
            continue;
          }
          await db
            .query(surql`CREATE type::record('events', ${idKey}) CONTENT ${fields}`)
            .collect();
          result.inserted += 1;
        }
      } catch (e) {
        result.errors.push({ external_id: row.external_id, error: e.message });
      }
    }
    return result;
  };
}
