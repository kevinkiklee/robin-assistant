import { RecordId, surql } from 'surrealdb';
import { sha256 } from '../../embed/hash.js';
import { buildFromV1, sourceHash } from '../audit.js';
import { recordFailure } from '../failures.js';
import { scanTable } from '../v1-client.js';

/**
 * Convert a resolver-stored record-ID string (e.g. 'episodes:abc123') back
 * to a SurrealDB RecordId so schema fields typed record<T> accept the value.
 */
function toRecordId(idStr) {
  const colon = idStr.indexOf(':');
  if (colon < 0) throw new Error(`invalid record id string: ${idStr}`);
  return new RecordId(idStr.slice(0, colon), idStr.slice(colon + 1));
}

export function buildCaptureRow(v1Row, { v2_episode_id }) {
  const body = v1Row.body ?? '';
  const row = {
    content: body,
    source: 'migration',
    content_hash: sha256(body),
    ts: v1Row.ts,
    external_id: `v1:${v1Row.id}`,
    trust: 'trusted',
    meta: {
      kind: 'v1_capture',
      v1_kind: v1Row.kind,
      v1_origin: v1Row.origin,
      v1_source: v1Row.source,
      v1_marker_id: v1Row.marker_id ?? null,
      ...(v1Row.meta ?? {}),
      ...(v1Row.archived_at ? { v1_archived_at: v1Row.archived_at } : {}),
      from_v1: buildFromV1({ v1_table: 'capture', v1_id: String(v1Row.id) }),
    },
  };
  if (v2_episode_id) row.episode_id = v2_episode_id;
  // embedding intentionally omitted — backfill picks up where embedding IS NONE
  return row;
}

export async function loadDerivedFromMap(v1) {
  const [rows] = await v1.query('SELECT in, out FROM derived_from').collect();
  const out = new Map();
  for (const r of rows ?? []) out.set(String(r.out), String(r.in));
  return out;
}

export async function runCapturePhase({ v1, v2db, resolver, progress }) {
  const derivedMap = await loadDerivedFromMap(v1);
  let imported = 0;
  let dup = 0;
  let lastId = progress?.cursor?.capture?.last_v1_id ?? null;

  for await (const batch of scanTable(v1, 'capture', { batch: 200, startAfter: lastId })) {
    for (const v1Row of batch) {
      const hash = sourceHash(String(v1Row.id));
      const [existing] = await v2db
        .query(surql`SELECT id FROM events WHERE meta.from_v1.source_hash = ${hash} LIMIT 1`)
        .collect();
      if (existing[0]?.id) {
        resolver.set('capture', String(v1Row.id), String(existing[0].id));
        dup++;
        continue;
      }
      try {
        const v1Episode = derivedMap.get(String(v1Row.id)) ?? null;
        const v2EpisodeIdStr = v1Episode ? resolver.get('episode', v1Episode) : null;
        // Resolver stores IDs as strings; convert to RecordId so schema field
        // TYPE record<episodes> accepts the value (plain strings are rejected).
        const v2EpisodeId = v2EpisodeIdStr ? toRecordId(v2EpisodeIdStr) : null;
        const row = buildCaptureRow(v1Row, { v2_episode_id: v2EpisodeId });
        // SurrealDB option<record<episodes>> rejects JS null — omit episode_id when absent.
        if (row.episode_id === null) delete row.episode_id;
        const [created] = await v2db.query(surql`CREATE events CONTENT ${row}`).collect();
        resolver.set('capture', String(v1Row.id), String(created[0].id));
        imported++;
      } catch (e) {
        await recordFailure(v2db, {
          v1_table: 'capture', v1_id: String(v1Row.id),
          error_message: e.message, phase: 'capture',
        });
      }
      lastId = String(v1Row.id);
    }
    progress.advance({ phase: 'capture', last_v1_id: lastId, imported, dup });
  }
  return { imported, dup };
}
