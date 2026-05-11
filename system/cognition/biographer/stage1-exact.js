import { surql } from 'surrealdb';

export async function stage1Resolve(db, { name, type }) {
  const lower = name.toLowerCase();
  const [rows] = await db
    .query(surql`SELECT id FROM entities WHERE name_lower = ${lower} AND type = ${type} LIMIT 1`)
    .collect();
  if (rows.length === 0) return null;
  return rows[0].id;
}
