// edge-writer.js — INSERT RELATION ... ON DUPLICATE KEY UPDATE.
//
// TYPE RELATION tables don't accept plain UPSERT/CREATE. Composite ID
// `edges:[kind, in, out]` enables idempotent upserts with merge semantics
// (e.g. accumulating LINKS.md contexts into `meta.contexts[]`).
//
// We rely on `cognition/memory/edge-registry.js` for kind/endpoint validation;
// failures bubble up as exceptions.

import { BoundQuery } from 'surrealdb';
import {
  canonicalEndpoints,
  recordIdFromString,
  recordStringId,
  validateEdge,
} from '../../../../cognition/memory/edge-registry.js';

/**
 * Upsert an edge. Returns `{ id, action: 'upserted' }` (we don't distinguish
 * create vs update on RELATION tables; idempotency is preserved by the
 * composite ID).
 *
 * For `mentions` / LINKS-style edges with a `context`, repeated calls with
 * different contexts accumulate into `meta.contexts` (an array, dedup'd).
 */
export async function upsertEdge(db, { from, to, kind, context, meta = {} }) {
  const v = validateEdge(from, to, kind);
  if (!v.ok) throw new Error(`upsertEdge: ${v.errors.join('; ')}`);
  const [cFrom, cTo] = canonicalEndpoints(from, to, kind);
  // INSERT RELATION rejects string bindings on `in`/`out` — see comment in
  // `cognition/memory/store.js#relateAll`. Coerce to RecordId before binding.
  const inRec = recordIdFromString(cFrom);
  const outRec = recordIdFromString(cTo);

  // Compute the merged meta JS-side. For `contexts`, accumulate (set-union).
  // For other meta keys, callsite values overwrite prior.
  const baseMeta = { ...meta };
  const incomingContext =
    context !== undefined && context !== null && context !== '' ? context : null;
  let priorMeta = {};
  {
    const [existing] = await db
      .query(
        new BoundQuery('SELECT meta FROM type::record("edges", [$kind, $inRec, $outRec])', {
          kind,
          inRec,
          outRec,
        }),
      )
      .collect();
    if (Array.isArray(existing) && existing.length > 0 && existing[0]?.meta) {
      priorMeta = existing[0].meta;
    }
  }
  const mergedContexts = (() => {
    const prior = Array.isArray(priorMeta.contexts) ? priorMeta.contexts : [];
    if (!incomingContext) return prior;
    return Array.from(new Set([...prior, incomingContext]));
  })();
  const mergedMeta = { ...priorMeta, ...baseMeta };
  if (mergedContexts.length > 0) mergedMeta.contexts = mergedContexts;

  const bindings = { kind, inRec, outRec, meta: mergedMeta };
  const sql = `INSERT RELATION INTO edges {
      id: [$kind, $inRec, $outRec],
      in: $inRec, out: $outRec, kind: $kind,
      last_seen: time::now(),
      meta: $meta
    } ON DUPLICATE KEY UPDATE
      kind = $kind, last_seen = time::now(), meta = $meta`;
  const [ret] = await db.query(new BoundQuery(sql, bindings)).collect();
  const row = Array.isArray(ret) ? ret[0] : ret;
  return {
    id: row?.id,
    action: 'upserted',
    fromId: recordStringId(cFrom),
    toId: recordStringId(cTo),
  };
}
