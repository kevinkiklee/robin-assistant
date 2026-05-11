import { surql } from 'surrealdb';

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

  // 3. Create new entity. Aliases preserved in meta for future passes.
  const embedding = Array.from(await embedder.embed(name));
  const [rows] = await db
    .query(
      surql`CREATE entities CONTENT ${{
        name,
        type,
        embedding,
        meta: { aliases: aliases.filter((a) => a && a !== name) },
      }}`,
    )
    .collect();
  return rows[0].id;
}
