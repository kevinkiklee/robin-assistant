// persona.js — the singleton model of Robin's user.
// Spec §5 / replaces profile.js. The underlying table renamed `profile` → `persona`.
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

  // First UPSERT (no SET) ensures the singleton row exists. Field-scoped
  // UPDATE … SET is then idempotent and field-local; concurrent writers to
  // disjoint keys do not clobber each other's siblings.
  await db.query(surql`UPSERT persona:singleton`).collect();

  // Build `SET k1 = $k1, k2 = $k2, …` with one bound parameter per key.
  const setClause = keys.map((k) => `${k} = $${k}`).join(', ');
  const sql = `UPDATE persona:singleton SET ${setClause}`;
  const params = Object.fromEntries(keys.map((k) => [k, fields[k]]));
  await db.query(new BoundQuery(sql, params)).collect();
}

/** Sub-helper used by dream/step-comm-style. */
export async function updateCommStyle(db, commStyleFields) {
  await updatePersonaFields(db, { comm_style: commStyleFields });
}

/** Sub-helper used by dream/step-calibration. */
export async function updateCalibration(db, calibrationFields) {
  await updatePersonaFields(db, { calibration: calibrationFields });
}

// Legacy aliases for backward compatibility during migration.
export const getProfile = getPersona;
export const updateProfileFields = updatePersonaFields;
