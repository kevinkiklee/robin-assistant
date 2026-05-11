// step-scope-cleanup.js — Promote referenced ephemeral memos to global,
// prune the rest. Theme 1c: iterates SCOPE_REGISTRY rather than hardcoded
// 'session:' / 'temp:' prefixes, so adding a new ephemeral scope is a
// registry edit, not a step edit.
//
// Fail-soft.

import { BoundQuery } from 'surrealdb';
import { ephemeralEntries, persistentScopesSqlFilter } from '../memory/scope-registry.js';

export async function dreamStepScopeCleanup(db, host, opts = {}) {
  void host;
  const now = opts.now instanceof Date ? opts.now : new Date();

  let promoted = 0;
  let pruned = 0;

  const ephemerals = ephemeralEntries();
  const persistentFilter = persistentScopesSqlFilter();

  // Build the ephemeral WHERE-fragment (registry-derived). All ephemerals are
  // prefix-keyed today; the loop handles exact-match keys defensively.
  const ephFragments = ephemerals.map(([pattern]) =>
    pattern.endsWith(':') ? `string::starts_with(scope, '${pattern}')` : `scope = '${pattern}'`,
  );
  if (ephFragments.length === 0) return { promoted, pruned };
  const ephemeralWhere = `(${ephFragments.join(' OR ')})`;

  // 1. Promote ephemerals with inbound derived_from from a non-ephemeral memo.
  const promoteSql = `
    UPDATE memos SET scope = 'global'
    WHERE ${ephemeralWhere}
      AND id IN (
        SELECT VALUE out FROM edges
        WHERE kind = 'derived_from'
          AND in IN (
            SELECT VALUE id FROM memos WHERE ${persistentFilter}
          )
      )
    RETURN BEFORE
  `;
  try {
    const [promotedRows] = await db.query(promoteSql).collect();
    promoted = promotedRows?.length ?? 0;
  } catch (e) {
    console.warn(`[dream] step-scope-cleanup promote: ${e.message}`);
  }

  // 2. Prune ephemerals past their per-pattern TTL.
  for (const [pattern, policy] of ephemerals) {
    const ttlMs = (policy.ttl_days ?? 1) * 86_400_000;
    const cutoff = new Date(now.getTime() - ttlMs);
    const where = pattern.endsWith(':')
      ? `string::starts_with(scope, '${pattern}')`
      : `scope = '${pattern}'`;
    try {
      const [deleted] = await db
        .query(
          new BoundQuery(`DELETE memos WHERE ${where} AND derived_at < $cutoff RETURN BEFORE`, {
            cutoff,
          }),
        )
        .collect();
      pruned += deleted?.length ?? 0;
    } catch (e) {
      console.warn(`[dream] step-scope-cleanup prune (${pattern}): ${e.message}`);
    }
  }

  return { promoted, pruned };
}
