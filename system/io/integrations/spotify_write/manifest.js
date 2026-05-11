import { createSpotifyWriteTool } from './tools/spotify-write.js';

export const manifest = {
  name: 'spotify_write',
  cadence: null,
  embed: true,
  capture_mode: 'insert-or-skip',
  secrets: {
    env_keys: ['SPOTIFY_REFRESH_TOKEN', 'SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET'],
    oauth: {
      provider: 'spotify',
      scopes: [
        'user-modify-playback-state',
        'playlist-modify-private',
        'playlist-modify-public',
        'user-library-modify',
      ],
    },
  },
  tools: [createSpotifyWriteTool],
};
