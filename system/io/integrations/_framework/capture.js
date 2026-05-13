import { BoundQuery, surql } from 'surrealdb';
import { sha256 } from '../../../data/embed/hash.js';
import { activeProfile, embeddingTable } from '../../../data/embed/profile-router.js';

// SurrealDB record-id components only need to survive being passed as a
// string literal, but historically we restricted to `[a-zA-Z0-9_-]` and
// hashed everything else. The previous hex-truncation-to-16 was unsafe:
// any external_id sharing a ≥8-byte prefix (e.g. `nhl:game:<id>`,
// `ebird:S<id>`) collided, and UPSERT silently kept overwriting one row.
// Use a sha256 prefix instead — 24 hex chars / 96 bits is comfortably past
// birthday-collision risk for realistic row counts.
function sanitizeIdPart(s) {
  return /^[a-zA-Z0-9_-]+$/.test(s) ? s : `h_${sha256(s).slice(0, 24)}`;
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
          // Integration data is external — default to `untrusted` so the
          // outbound verbatim-quote guard (outbound-policy.js) scans these
          // rows. Individual integrations may override (e.g. Robin's own
          // discord_dispatcher already passes `trust: 'untrusted'`); a future
          // first-party source can explicitly opt into `'trusted'` by setting
          // `row.trust` upstream.
          trust: row.trust ?? 'untrusted',
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
