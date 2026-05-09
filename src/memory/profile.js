import { surql } from 'surrealdb';

/**
 * User profile — singleton row at `profile:singleton`.
 *
 * One row exists per Robin instance, addressed by deterministic ID.
 * Use `type::record('profile', 'singleton')` to resolve the literal record.
 * Created lazily on first `updateProfileFields` call via `UPSERT ... MERGE`.
 */
export async function getProfile(db) {
  const [rows] = await db
    .query(surql`SELECT * FROM type::record('profile', 'singleton') LIMIT 1`)
    .collect();
  return rows[0] ?? null;
}

export async function updateProfileFields(db, fields) {
  await db.query(surql`UPSERT type::record('profile', 'singleton') MERGE ${fields}`).collect();
}
