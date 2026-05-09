import { surql } from 'surrealdb';

/**
 * Recurring observations identified by the dream agent.
 *
 * Upsertable by `name`: each subsequent upsert with the same name increments
 * `signal_count`, refreshes `last_signal`, and unions in any new
 * `source_events`. Strength stays at the schema default (1.0) for now —
 * decay/promotion lives in a later task.
 */
export async function createPattern(db, input) {
  const { name, description, source_events, meta } = input;
  const fields = {
    name,
    description,
    source_events,
    ...(meta ? { meta } : {}),
  };
  const [created] = await db.query(surql`CREATE patterns CONTENT ${fields}`).collect();
  const row = Array.isArray(created) ? created[0] : created;
  return { id: row.id };
}

export async function upsertPatternByName(db, input) {
  const { name, description, source_events, meta } = input;
  const [existing] = await db
    .query(surql`SELECT id, signal_count FROM patterns WHERE name = ${name} LIMIT 1`)
    .collect();
  if (existing.length > 0) {
    const id = existing[0].id;
    await db
      .query(
        surql`UPDATE ${id} SET description = ${description}, signal_count = signal_count + 1, last_signal = time::now(), source_events = array::union(source_events, ${source_events})`,
      )
      .collect();
    return { id };
  }
  return await createPattern(db, { name, description, source_events, meta });
}

export async function listPatterns(db, { activeOnly = false, limit = 50 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error(`listPatterns: limit out of range [1,1000]: ${limit}`);
  }
  const where = activeOnly ? 'WHERE strength > 0' : '';
  const sql = `SELECT id, name, description, signal_count, strength, last_signal FROM patterns ${where} ORDER BY last_signal DESC LIMIT ${limit}`;
  const [rows] = await db.query(sql).collect();
  return rows;
}
