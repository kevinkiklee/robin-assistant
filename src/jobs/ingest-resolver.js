import { surql } from 'surrealdb';
import * as store from '../memory/store.js';

async function findByNameLower(db, name, type) {
  const [rows] = await db
    .query(
      surql`SELECT id, meta FROM entities WHERE name_lower = ${name.toLowerCase()} AND type = ${type} LIMIT 1`,
    )
    .collect();
  return rows?.[0] ?? null;
}

export async function resolveOrCreateEntity(db, embedder, { name, type, aliases = [] }) {
  // 1. Exact name match (composite index entities_name_lower covers this).
  const exact = await findByNameLower(db, name, type);
  if (exact) return exact.id;

  // 2. Alias-as-name match — each alias tried as a name lookup.
  for (const alias of aliases) {
    if (!alias || alias === name) continue;
    const hit = await findByNameLower(db, alias, type);
    if (hit) return hit.id;
  }

  // 3. Create via the store primitive — entity row + per-profile embedding row.
  const meta = { aliases: aliases.filter((a) => a && a !== name) };
  const result = await store.upsertEntity(db, embedder, { name, type, meta });
  return result.id;
}
