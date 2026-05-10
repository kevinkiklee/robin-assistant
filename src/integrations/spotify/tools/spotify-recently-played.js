import { BoundQuery } from 'surrealdb';

export function createSpotifyRecentlyPlayedTool({ db }) {
  return {
    name: 'spotify_recently_played',
    description: 'List recently-played Spotify tracks captured from the events table.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        since: {
          type: 'string',
          description: 'ISO 8601 timestamp; only return plays after this time.',
        },
      },
    },
    handler: async (args) => {
      const limit = Math.min(args.limit ?? 50, 200);
      const filters = ["source = 'spotify'", "meta.kind = 'spotify_played'"];
      const bindings = {};
      if (args.since) {
        filters.push('ts >= $since');
        bindings.since = args.since;
      }
      const sql = `SELECT id, external_id, content, ts, meta FROM events WHERE ${filters.join(' AND ')} ORDER BY ts DESC LIMIT ${limit}`;
      const [rows] = await db.query(new BoundQuery(sql, bindings)).collect();
      return { plays: rows.map((r) => ({ ...r, id: String(r.id) })) };
    },
  };
}
