import { surql } from 'surrealdb';

const ID = "type::record('runtime', 'migration_id_map')";

export function createResolver(db) {
  const maps = { entity: new Map(), episode: new Map(), capture: new Map() };

  return {
    set(kind, v1_id, v2_id) {
      if (!maps[kind]) throw new Error(`unknown resolver kind: ${kind}`);
      maps[kind].set(v1_id, v2_id);
    },
    get(kind, v1_id) {
      return maps[kind]?.get(v1_id) ?? null;
    },
    has(kind, v1_id) {
      return maps[kind]?.has(v1_id) ?? false;
    },
    sizes() {
      return Object.fromEntries(Object.entries(maps).map(([k, m]) => [k, m.size]));
    },
    async persist() {
      const value = {
        entity: Object.fromEntries(maps.entity),
        episode: Object.fromEntries(maps.episode),
        capture: Object.fromEntries(maps.capture),
      };
      await db
        .query(surql`UPSERT type::record('runtime', 'migration_id_map') SET value = ${value}`)
        .collect();
    },
    async load() {
      const [rows] = await db.query(`SELECT * FROM ${ID}`).collect();
      const value = rows[0]?.value ?? {};
      for (const kind of ['entity', 'episode', 'capture']) {
        maps[kind] = new Map(Object.entries(value[kind] ?? {}));
      }
    },
  };
}
