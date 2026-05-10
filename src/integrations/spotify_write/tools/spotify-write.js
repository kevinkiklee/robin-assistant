import { checkOutbound } from '../../../outbound/policy.js';
import { checkRateLimit } from '../../../outbound/rate-limit.js';
import { addToPlaylist, queueTrack, skipTrack } from '../client.js';

function mapSpotifyError(e) {
  if (e?.status === 404) return { ok: false, reason: 'no_active_device' };
  if (e?.status === 403 && /premium/i.test(e.message ?? ''))
    return { ok: false, reason: 'premium_required' };
  if (/missing secret/.test(e?.message ?? '')) {
    return {
      ok: false,
      reason: 'not_authenticated',
      detail: 'spotify not authenticated; run: robin secrets import --from <v1-user-data>',
    };
  }
  return { ok: false, reason: 'spotify_error', detail: e?.message };
}

export function createSpotifyWriteTool({ db, capture }) {
  return {
    name: 'spotify_write',
    description: 'Spotify playback control: queue track, skip, add to playlist.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['queue', 'skip', 'playlist-add'] },
        args: { type: 'object' },
      },
      required: ['action', 'args'],
    },
    handler: async (input) => {
      const { action, args } = input;
      const rate = await checkRateLimit(db, 'spotify_write');
      if (!rate.ok) return rate;

      try {
        switch (action) {
          case 'queue': {
            if (!args.track_uri) return { ok: false, reason: 'missing_arg', arg: 'track_uri' };
            const policy = await checkOutbound(db, {
              destination: 'spotify_write',
              text: args.track_uri,
            });
            if (!policy.ok)
              return { ok: false, reason: 'outbound_blocked', blocked_by: policy.reason };
            await queueTrack(args);
            console.log(`[spotify_write] queued ${args.track_uri}`);
            return { ok: true, queued: args.track_uri };
          }
          case 'skip': {
            await skipTrack({});
            console.log('[spotify_write] skipped');
            return { ok: true };
          }
          case 'playlist-add': {
            if (
              !args.playlist_id ||
              !Array.isArray(args.track_uris) ||
              args.track_uris.length === 0
            ) {
              return { ok: false, reason: 'missing_arg', arg: 'playlist_id or track_uris' };
            }
            if (args.track_uris.length > 100) {
              return {
                ok: false,
                reason: 'too_many_tracks',
                max: 100,
                given: args.track_uris.length,
              };
            }
            const text = args.track_uris.join(', ');
            const policy = await checkOutbound(db, { destination: 'spotify_write', text });
            if (!policy.ok)
              return { ok: false, reason: 'outbound_blocked', blocked_by: policy.reason };
            const r = await addToPlaylist(args);
            await capture([
              {
                source: 'spotify_write',
                content: `playlist-add: ${args.playlist_id} · ${args.track_uris.length} tracks`,
                external_id: `${args.playlist_id}:${Date.now()}`,
                meta: {
                  action: 'playlist-add',
                  playlist_id: args.playlist_id,
                  track_uris: args.track_uris,
                  snapshot_id: r?.snapshot_id,
                },
              },
            ]);
            return { ok: true, snapshot_id: r?.snapshot_id, count: args.track_uris.length };
          }
          default:
            return { ok: false, reason: 'unknown_action', action };
        }
      } catch (e) {
        return mapSpotifyError(e);
      }
    },
  };
}
