// persona.js — the singleton model of Robin's user.
// Spec §5 / replaces profile.js. The underlying table renamed `profile` → `persona`.
//
// Backward-compat note: `getProfile` and `updateProfileFields` aliases are
// exported at the bottom of this file because several call sites still use
// the old names. Prefer `getPersona` / `updatePersonaFields` in new code;
// remove the aliases once existing callers migrate.
// C2 spec §1.2: field-scoped `UPDATE … SET` replaces `UPSERT … MERGE` so
// concurrent writers to disjoint top-level keys no longer overwrite each other
// at record level. Cross-process safety: dream steps and the cadence consumer
// can both call `updatePersonaFields` without coordination.

import { BoundQuery, surql } from 'surrealdb';

export async function getPersona(db) {
  const [rows] = await db.query(surql`SELECT * FROM persona:singleton LIMIT 1`).collect();
  return rows[0] ?? null;
}

export async function updatePersonaFields(db, fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new TypeError('updatePersonaFields: fields must be a plain object');
  }
  const keys = Object.keys(fields);
  if (keys.length === 0) return; // No-op; nothing to set.

  // Guard against accidental SurrealQL-identifier characters in keys. The
  // allowed shape is [a-zA-Z_][a-zA-Z0-9_]* — exactly what JS object keys
  // produced by trusted callers in cognition/memory and cognition/dream emit.
  // Untrusted callers should sanitise upstream; we hard-fail here rather than
  // build a query with attacker-controlled identifiers.
  for (const k of keys) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) {
      throw new RangeError(`updatePersonaFields: invalid field name '${k}'`);
    }
  }

  // Build `SET k1 = $k1, k2 = $k2, …` with one bound parameter per key.
  // UPSERT … SET (not MERGE) writes only the listed top-level fields and
  // preserves untouched siblings (verified by persona-set-refactor.test.js).
  // Concurrent writers to disjoint keys do not lose each other's writes at
  // the application layer; on optimistic-concurrency engines (SurrealDB v3)
  // a transaction may still report a write-conflict, which we retry below.
  const setClause = keys.map((k) => `${k} = $${k}`).join(', ');
  const sql = `UPSERT persona:singleton SET ${setClause}`;
  const params = Object.fromEntries(keys.map((k) => [k, fields[k]]));

  // Retry on transaction conflicts (engine-level optimistic concurrency).
  // Each conflict bubbles up as an error whose message contains
  // 'Transaction conflict' / 'Write conflict'; on retry the writer re-reads
  // the record and re-applies its field-scoped SET, so no write is lost.
  const MAX_ATTEMPTS = 8;
  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await db.query(new BoundQuery(sql, params)).collect();
      return;
    } catch (e) {
      lastErr = e;
      const msg = e?.message ?? '';
      if (!/conflict/i.test(msg)) throw e;
      // brief backoff with jitter to break the retry cycle
      await new Promise((r) => setTimeout(r, 2 + Math.random() * 10));
    }
  }
  throw lastErr;
}

/** Sub-helper used by dream/step-calibration. */
export async function updateCalibration(db, calibrationFields) {
  await updatePersonaFields(db, { calibration: calibrationFields });
}

// Legacy aliases for backward compatibility during migration.
export const getProfile = getPersona;
export const updateProfileFields = updatePersonaFields;
