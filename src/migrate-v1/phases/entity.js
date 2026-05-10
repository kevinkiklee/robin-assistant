import { surql } from 'surrealdb';
import { buildFromV1, sourceHash } from '../audit.js';
import { recordFailure } from '../failures.js';
import { scanTable } from '../v1-client.js';

const KIND_MAP = {
  person: 'person',
  place: 'place',
  project: 'project',
  decision: 'topic',
  concept: 'topic',
  event: 'topic',
  task: 'topic',
  tool: 'thing',
  integration: 'thing',
  source: 'thing',
};

export function mapEntityKind(v1Kind) {
  return KIND_MAP[v1Kind] ?? 'thing';
}

export function buildEntityRow(v1Row) {
  return {
    name: v1Row.name,
    type: mapEntityKind(v1Row.kind),
    meta: {
      kind: 'v1_entity',
      v1_kind: v1Row.kind,
      slug: v1Row.slug,
      aliases: v1Row.aliases ?? [],
      summary: v1Row.summary ?? '',
      ...(v1Row.meta ?? {}),
      from_v1: buildFromV1({ v1_table: 'entity', v1_id: String(v1Row.id) }),
    },
    created_at: v1Row.created ?? new Date().toISOString(),
  };
}

export async function runEntityPhase({ v1, v2db, resolver, embedder, progress }) {
  let imported = 0;
  let dup = 0;
  let lastId = progress?.cursor?.entity?.last_v1_id ?? null;

  for await (const batch of scanTable(v1, 'entity', { batch: 200, startAfter: lastId })) {
    for (const v1Row of batch) {
      const hash = sourceHash(String(v1Row.id));
      const [existing] = await v2db
        .query(surql`SELECT id FROM entities WHERE meta.from_v1.source_hash = ${hash} LIMIT 1`)
        .collect();
      if (existing[0]?.id) {
        resolver.set('entity', String(v1Row.id), String(existing[0].id));
        dup++;
        continue;
      }
      try {
        const row = buildEntityRow(v1Row);
        // entities schema requires array<float> embedding at the active dim.
        // We write a zero-vector placeholder; future entity-backfill (out of 3b scope) can refresh.
        const dim = embedder?.dimension ?? 1024;
        const stub = new Array(dim).fill(0);
        const [created] = await v2db
          .query(surql`CREATE entities CONTENT ${{ ...row, embedding: stub }}`)
          .collect();
        resolver.set('entity', String(v1Row.id), String(created[0].id));
        imported++;
      } catch (e) {
        await recordFailure(v2db, {
          v1_table: 'entity',
          v1_id: String(v1Row.id),
          error_message: e.message,
          phase: 'entity',
        });
      }
      lastId = String(v1Row.id);
    }
    progress.advance({ phase: 'entity', last_v1_id: lastId, imported, dup });
  }
  return { imported, dup };
}
