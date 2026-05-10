import { surql } from 'surrealdb';

async function readEntries(db) {
  const [rows] = await db
    .query(`SELECT * FROM type::record('runtime', 'migration_failures')`)
    .collect();
  return rows[0]?.value?.entries ?? [];
}

export async function recordFailure(db, { v1_table, v1_id, error_message, phase = null }) {
  const entries = await readEntries(db);
  entries.push({
    v1_table,
    v1_id,
    phase,
    error_message: String(error_message),
    occurred_at: new Date().toISOString(),
  });
  await db
    .query(surql`UPSERT type::record('runtime', 'migration_failures') SET value = ${{ entries }}`)
    .collect();
}

export async function listFailures(db, { phase = null } = {}) {
  const entries = await readEntries(db);
  if (phase) return entries.filter((e) => e.phase === phase || e.v1_table === phase);
  return entries;
}

export async function clearFailures(db) {
  await db
    .query(
      surql`UPSERT type::record('runtime', 'migration_failures') SET value = ${{ entries: [] }}`,
    )
    .collect();
}
