import { BoundQuery } from 'surrealdb';

async function latest(db, kind) {
  const sql = `SELECT id, content, ts, meta FROM events WHERE source = 'whoop' AND meta.kind = $kind ORDER BY ts DESC LIMIT 1`;
  const [rows] = await db.query(new BoundQuery(sql, { kind })).collect();
  if (!rows[0]) return null;
  return { ...rows[0], id: String(rows[0].id) };
}

export function createWhoopTodayTool({ db }) {
  return {
    name: 'whoop_today',
    description:
      "Today (per Whoop's 4am-anchored cycle): most recent recovery, most recent sleep, last workout.",
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const [recovery, sleep, last_workout] = await Promise.all([
        latest(db, 'recovery'),
        latest(db, 'sleep'),
        latest(db, 'workout'),
      ]);
      return { recovery, sleep, last_workout };
    },
  };
}
