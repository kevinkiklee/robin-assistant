// privacy.js — direct + transitive private-scope filter for belief() hits.
// Spec §2.5. Stricter than D1 (which filters direct-only) because belief()
// exposes memo content directly in evidence[].
//
// Direct check: drop hits whose own scope policy is outbound-blocked.
// Transitive check: drop hits whose `derived_from` lineage touches any
// private memo. Lineage is traversed one hop via the `edges` table — the
// canonical lineage shape in this repo (see store.js getMemo).

import { BoundQuery } from 'surrealdb';
import { isOutboundBlocked } from '../memory/scope-registry.js';

/**
 * Drop refs whose scope is direct-private OR whose `derived_from` lineage
 * touches a private memo. Returns { kept_ids, dropped_ids }.
 *
 * Note (spec §2.5): we do NOT write a `refusals` row per drop — the
 * aggregate-level meta.hits_dropped_private is the right granularity, and
 * belief()'s callers don't see dropped IDs.
 */
export async function filterPrivateRefs(db, refs) {
  if (!Array.isArray(refs) || refs.length === 0) {
    return { kept_ids: [], dropped_ids: [] };
  }

  // Direct check.
  const [directRows] = await db
    .query(new BoundQuery('SELECT id, scope FROM memos WHERE id IN $ids', { ids: refs }))
    .collect();
  const directBlocked = new Set();
  for (const r of directRows ?? []) {
    if (r.scope && isOutboundBlocked(r.scope)) {
      directBlocked.add(String(r.id));
    }
  }

  // Transitive check — only for refs not already dropped by direct.
  const remaining = refs.filter((r) => !directBlocked.has(String(r)));
  const transitiveBlocked = new Set();
  if (remaining.length > 0) {
    // For each remaining memo, look up its `derived_from` lineage targets
    // (via the canonical `edges` table). If any lineage target is a memo
    // with private scope, the memo is transitively blocked.
    const [lineRows] = await db
      .query(
        new BoundQuery(
          `SELECT in AS memo_id, out AS lineage
           FROM edges
           WHERE kind = 'derived_from' AND in IN $ids`,
          { ids: remaining },
        ),
      )
      .collect();
    const lineageByMemo = new Map();
    const allLineageTargets = [];
    for (const r of lineRows ?? []) {
      const k = String(r.memo_id);
      const t = r.lineage;
      if (!t) continue;
      if (!lineageByMemo.has(k)) lineageByMemo.set(k, []);
      lineageByMemo.get(k).push(t);
      allLineageTargets.push(t);
    }
    if (allLineageTargets.length > 0) {
      const [parentRows] = await db
        .query(
          new BoundQuery(`SELECT id, scope FROM memos WHERE id IN $ids AND scope = 'private'`, {
            ids: allLineageTargets,
          }),
        )
        .collect();
      const privateLineageIds = new Set((parentRows ?? []).map((r) => String(r.id)));
      if (privateLineageIds.size > 0) {
        for (const [memoId, targets] of lineageByMemo) {
          if (targets.some((t) => privateLineageIds.has(String(t)))) {
            transitiveBlocked.add(memoId);
          }
        }
      }
    }
  }

  const kept_ids = [];
  const dropped_ids = [];
  for (const r of refs) {
    const k = String(r);
    if (directBlocked.has(k) || transitiveBlocked.has(k)) {
      dropped_ids.push(r);
    } else {
      kept_ids.push(r);
    }
  }
  return { kept_ids, dropped_ids };
}
