import { surql } from 'surrealdb';
import { buildFromV1, sourceHash } from '../audit.js';
import { recordFailure } from '../failures.js';
import { scanTable } from '../v1-client.js';

export function buildParticipatesInPayload(v1Row) {
  return {
    meta: {
      kind: 'v1_participates_in',
      v1_payload: {
        confidence: v1Row.confidence,
        archived_at: v1Row.archived_at ?? null,
        valid_from: v1Row.valid_from ?? null,
        valid_until: v1Row.valid_until ?? null,
        derived_from: (v1Row.derived_from ?? []).map(String),
      },
      from_v1: buildFromV1({ v1_table: 'participates_in', v1_id: String(v1Row.id) }),
    },
  };
}

export async function runEdgesPhase({ v1, v2db, resolver, progress }) {
  let imported = 0;
  let dup = 0;
  let skipped = 0;
  let lastId = progress?.cursor?.edges?.last_v1_id ?? null;

  try {
    for await (const batch of scanTable(v1, 'participates_in', { batch: 200, startAfter: lastId })) {
      for (const v1Row of batch) {
        const v2In = resolver.get('entity', String(v1Row.in));
        const v2Out = resolver.get('entity', String(v1Row.out));
        if (!v2In || !v2Out) {
          await recordFailure(v2db, {
            v1_table: 'participates_in',
            v1_id: String(v1Row.id),
            error_message: `endpoint not in resolver (in=${v1Row.in} out=${v1Row.out})`,
            phase: 'edges',
          });
          skipped++;
          lastId = String(v1Row.id);
          continue;
        }
        const hash = sourceHash(String(v1Row.id));
        const [existing] = await v2db
          .query(
            surql`SELECT id FROM participates_in WHERE meta.from_v1.source_hash = ${hash} LIMIT 1`,
          )
          .collect();
        if (existing[0]?.id) {
          dup++;
          lastId = String(v1Row.id);
          continue;
        }
        try {
          const payload = buildParticipatesInPayload(v1Row);
          await v2db
            .query(
              surql`RELATE type::thing(${v2In})->participates_in->type::thing(${v2Out}) SET meta = ${payload.meta}`,
            )
            .collect();
          imported++;
        } catch (e) {
          await recordFailure(v2db, {
            v1_table: 'participates_in',
            v1_id: String(v1Row.id),
            error_message: e.message,
            phase: 'edges',
          });
        }
        lastId = String(v1Row.id);
      }
      progress.advance({ phase: 'edges', last_v1_id: lastId, imported, dup, skipped });
    }
  } catch (e) {
    // participates_in may not exist in every v1 instance — treat as empty table.
    if (!/(?:not found|does not exist)/i.test(String(e?.message))) throw e;
  }
  return { imported, dup, skipped };
}
