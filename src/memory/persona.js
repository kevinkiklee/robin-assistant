// persona.js — the singleton model of Robin's user.
// Spec §5 / replaces profile.js. The underlying table renamed `profile` → `persona`.

import { surql } from 'surrealdb';

export async function getPersona(db) {
  const [rows] = await db.query(surql`SELECT * FROM persona:singleton LIMIT 1`).collect();
  return rows[0] ?? null;
}

export async function updatePersonaFields(db, fields) {
  await db.query(surql`UPSERT persona:singleton MERGE ${fields}`).collect();
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
