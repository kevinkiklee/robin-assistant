import { surql } from 'surrealdb';

export function createWeatherTodayTool({ db }) {
  return {
    name: 'weather_today',
    description: 'Returns the most recent captured weather event for the configured location.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const [rows] = await db
        .query(
          surql`SELECT id, content, ts, meta FROM events WHERE source = 'weather' ORDER BY ts DESC LIMIT 1`,
        )
        .collect();
      const row = rows[0];
      return { weather: row ? { ...row, id: String(row.id) } : null };
    },
  };
}
