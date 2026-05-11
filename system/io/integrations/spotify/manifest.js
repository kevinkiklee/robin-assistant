import { sync } from './sync.js';
import { createSpotifyRecentlyPlayedTool } from './tools/spotify-recently-played.js';
import { createSpotifyTopItemsTool } from './tools/spotify-top-items.js';

export const manifest = {
  name: 'spotify',
  cadence: '4h',
  embed: true,
  capture_mode: 'insert-or-skip',
  secrets: {
    env_keys: ['SPOTIFY_REFRESH_TOKEN', 'SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET'],
    oauth: {
      provider: 'spotify',
      scopes: ['user-read-recently-played', 'user-top-read'],
    },
  },
  sync,
  tools: [createSpotifyRecentlyPlayedTool, createSpotifyTopItemsTool],
};
