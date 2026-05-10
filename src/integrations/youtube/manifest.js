import { sync } from './sync.js';
import { createYouTubeListLikedTool } from './tools/youtube-list-liked.js';
import { createYouTubeListSubscriptionsTool } from './tools/youtube-list-subscriptions.js';

export const manifest = {
  name: 'youtube',
  cadence: '1d',
  embed: true,
  capture_mode: 'insert-or-skip',
  secrets: {
    env_keys: [
      'GOOGLE_OAUTH_REFRESH_TOKEN',
      'GOOGLE_OAUTH_CLIENT_ID',
      'GOOGLE_OAUTH_CLIENT_SECRET',
    ],
  },
  sync,
  tools: [createYouTubeListSubscriptionsTool, createYouTubeListLikedTool],
};
