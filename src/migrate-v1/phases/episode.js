import { surql } from 'surrealdb';
import { buildFromV1, sourceHash } from '../audit.js';
import { recordFailure } from '../failures.js';
import { scanTable } from '../v1-client.js';

export function buildEpisodeRow(v1Row) {
  return {
    started_at: v1Row.started_at,
    ended_at: v1Row.ended_at ?? null,
    source: 'migration',
    summary: v1Row.summary ?? null,
    meta: {
      kind: 'v1_episode',
      v1_kind: v1Row.kind,
      title: v1Row.title ?? null,
      ...(v1Row.meta ?? {}),
      from_v1: buildFromV1({ v1_table: 'episode', v1_id: String(v1Row.id) }),
    },
  };
}

export async function runEpisodePhase({ v1, v2db, resolver, progress }) {
  let imported = 0;
  let dup = 0;
  let lastId = progress?.cursor?.episode?.last_v1_id ?? null;
  for await (const batch of scanTable(v1, 'episode', { batch: 200, startAfter: lastId })) {
    for (const v1Row of batch) {
      const hash = sourceHash(String(v1Row.id));
      const [existing] = await v2db
        .query(surql`SELECT id FROM episodes WHERE meta.from_v1.source_hash = ${hash} LIMIT 1`)
        .collect();
      if (existing[0]?.id) {
        resolver.set('episode', String(v1Row.id), String(existing[0].id));
        dup++;
        continue;
      }
      try {
        const row = buildEpisodeRow(v1Row);
        const [created] = await v2db.query(surql`CREATE episodes CONTENT ${row}`).collect();
        resolver.set('episode', String(v1Row.id), String(created[0].id));
        imported++;
      } catch (e) {
        await recordFailure(v2db, {
          v1_table: 'episode',
          v1_id: String(v1Row.id),
          error_message: e.message,
          phase: 'episode',
        });
      }
      lastId = String(v1Row.id);
    }
    progress.advance({ phase: 'episode', last_v1_id: lastId, imported, dup });
  }
  return { imported, dup };
}
