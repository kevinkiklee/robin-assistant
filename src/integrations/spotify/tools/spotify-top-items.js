import { BoundQuery } from 'surrealdb';

const VALID_KINDS = ['tracks', 'artists'];
const VALID_WINDOWS = ['short_term', 'medium_term', 'long_term'];

function currentMonthBucket() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export function createSpotifyTopItemsTool({ db }) {
  return {
    name: 'spotify_top_items',
    description:
      'Retrieve Spotify top tracks or artists for a given time window from the events table. Returns month-bucketed snapshots.',
    inputSchema: {
      type: 'object',
      required: ['kind', 'window'],
      properties: {
        kind: {
          type: 'string',
          enum: VALID_KINDS,
          description: "Item type: 'tracks' or 'artists'.",
        },
        window: {
          type: 'string',
          enum: VALID_WINDOWS,
          description: "Spotify time range: 'short_term', 'medium_term', or 'long_term'.",
        },
        month: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}$',
          description: 'Month bucket in YYYY-MM format (defaults to current month).',
        },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
    },
    handler: async (args) => {
      if (!VALID_KINDS.includes(args.kind)) {
        throw new Error(`invalid kind: ${args.kind}. Must be one of: ${VALID_KINDS.join(', ')}`);
      }
      if (!VALID_WINDOWS.includes(args.window)) {
        throw new Error(
          `invalid window: ${args.window}. Must be one of: ${VALID_WINDOWS.join(', ')}`,
        );
      }

      const metaKind = args.kind === 'tracks' ? 'spotify_top_track' : 'spotify_top_artist';
      const month = args.month ?? currentMonthBucket();
      const limit = Math.min(args.limit ?? 50, 200);

      const sql = `SELECT id, external_id, content, ts, meta FROM events WHERE source = 'spotify' AND meta.kind = $kind AND meta.window = $window AND meta.month = $month ORDER BY ts DESC LIMIT ${limit}`;
      const [rows] = await db
        .query(new BoundQuery(sql, { kind: metaKind, window: args.window, month }))
        .collect();

      return { items: rows.map((r) => ({ ...r, id: String(r.id) })) };
    },
  };
}
