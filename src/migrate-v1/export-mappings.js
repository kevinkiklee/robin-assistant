import { writeFile } from 'node:fs/promises';

async function tableMap(db, table) {
  const [rows] = await db
    .query(`SELECT id, meta.from_v1.v1_id AS v1_id FROM ${table} WHERE meta.from_v1 IS NOT NONE`)
    .collect();
  const out = {};
  for (const r of rows ?? []) {
    if (r.v1_id) out[String(r.v1_id)] = String(r.id);
  }
  return out;
}

export async function exportMappings(db, outPath) {
  const data = {
    entities: await tableMap(db, 'entities'),
    episodes: await tableMap(db, 'episodes'),
    events: await tableMap(db, 'events'),
  };
  await writeFile(outPath, JSON.stringify(data, null, 2), 'utf-8');
}
