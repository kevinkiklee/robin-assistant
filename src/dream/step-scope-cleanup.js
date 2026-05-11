// step-scope-cleanup.js — Promote referenced ephemeral memos to global,
// prune the rest.
//
// Spec §9. Ephemeral scopes are `session:*` (TTL 7d) and `temp:*` (TTL 24h).
// If an ephemeral memo has an inbound `derived_from` edge from a non-
// ephemeral memo (global / project:* / integration:* / private), it gets
// promoted to 'global' — the user-meaningful chain of "this fact came from
// that ephemeral observation" should outlive the session.
//
// Fail-soft.

import { BoundQuery } from 'surrealdb';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d
const TEMP_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export async function dreamStepScopeCleanup(db, host, opts = {}) {
  void host;
  const now = opts.now instanceof Date ? opts.now : new Date();

  let promoted = 0;
  let pruned = 0;

  // 1. Find all ephemeral memos with inbound derived_from from a non-ephemeral
  //    memo → promote to global. v3 parser doesn't accept NOT in front of a
  //    function-call expression in WHERE; use the positive form instead.
  const promoteSql = `
    UPDATE memos SET scope = 'global'
    WHERE (string::starts_with(scope, 'session:') OR string::starts_with(scope, 'temp:'))
      AND id IN (
        SELECT VALUE out FROM edges
        WHERE kind = 'derived_from'
          AND in IN (
            SELECT VALUE id FROM memos
            WHERE scope = 'global'
               OR scope = 'private'
               OR string::starts_with(scope, 'project:')
               OR string::starts_with(scope, 'integration:')
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

  // 2. Prune ephemerals past their TTL.
  try {
    const sessionCutoff = new Date(now.getTime() - SESSION_TTL_MS);
    const [sessionDeleted] = await db
      .query(
        new BoundQuery(
          `DELETE memos WHERE string::starts_with(scope, 'session:')
             AND derived_at < $cutoff RETURN BEFORE`,
          { cutoff: sessionCutoff },
        ),
      )
      .collect();
    pruned += sessionDeleted?.length ?? 0;
  } catch (e) {
    console.warn(`[dream] step-scope-cleanup prune session: ${e.message}`);
  }

  try {
    const tempCutoff = new Date(now.getTime() - TEMP_TTL_MS);
    const [tempDeleted] = await db
      .query(
        new BoundQuery(
          `DELETE memos WHERE string::starts_with(scope, 'temp:')
             AND derived_at < $cutoff RETURN BEFORE`,
          { cutoff: tempCutoff },
        ),
      )
      .collect();
    pruned += tempDeleted?.length ?? 0;
  } catch (e) {
    console.warn(`[dream] step-scope-cleanup prune temp: ${e.message}`);
  }

  return { promoted, pruned };
}
