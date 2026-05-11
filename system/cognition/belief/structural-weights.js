// structural-weights.js — single-round-trip batched fetch of the
// weight inputs (signal_count, decay_anchor, reinforced, supersedes_count)
// and JS-side decay computation using HALF_LIFE_BY_KIND_MS.
// Spec §2.3.

import { BoundQuery } from 'surrealdb';
import { HALF_LIFE_BY_KIND_MS } from '../memory/decay.js';

const DEFAULT_HALF_LIFE = 14 * 24 * 60 * 60 * 1000; // 14d fallback

/**
 * @param {import('surrealdb').Surreal} db
 * @param {Array<string|object>} ids
 * @returns {Promise<Map<string, {structural:number, signal_count:number, decay:number, supersedes_count:number, kind:string}>>}
 */
export async function batchStructuralWeights(db, ids) {
  const out = new Map();
  if (!Array.isArray(ids) || ids.length === 0) return out;

  // `supersedes` edges live on the canonical `edges` table; count inbound
  // supersedes (i.e. other memos pointing AT this one as superseding it).
  const [rows] = await db
    .query(
      new BoundQuery(
        `SELECT id, kind, signal_count, decay_anchor, reinforced,
                count((SELECT id FROM edges WHERE kind = 'supersedes' AND out = $parent.id)) AS sup
         FROM memos WHERE id IN $ids`,
        { ids },
      ),
    )
    .collect();

  const now = Date.now();
  for (const r of rows ?? []) {
    const k = String(r.id);
    const sup = Number(r.sup ?? 0);
    let decay = 0;
    if (sup === 0) {
      const halfLife = HALF_LIFE_BY_KIND_MS[r.kind] ?? DEFAULT_HALF_LIFE;
      const anchor = r.decay_anchor ? new Date(r.decay_anchor).getTime() : now;
      const age = Math.max(0, now - anchor);
      decay = 2 ** (-age / halfLife);
      const reinforced = Number(r.reinforced ?? 1);
      decay = decay * Math.max(1, reinforced);
    }
    const signal_count = Number(r.signal_count ?? 1);
    out.set(k, {
      structural: signal_count * decay,
      signal_count,
      decay,
      supersedes_count: sup,
      kind: r.kind,
    });
  }
  return out;
}
