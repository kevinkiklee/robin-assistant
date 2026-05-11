import { getSecret } from '../../secrets/dotenv-io.js';
import { sync } from './sync.js';
import { createGaRecentTool } from './tools/ga-recent.js';

export const manifest = {
  name: 'ga',
  cadence: '1d',
  embed: true,
  capture_mode: 'upsert',
  secrets: {
    env_keys: [
      'GOOGLE_OAUTH_REFRESH_TOKEN',
      'GOOGLE_OAUTH_CLIENT_ID',
      'GOOGLE_OAUTH_CLIENT_SECRET',
    ],
    oauth: { provider: 'google', scopes: ['https://www.googleapis.com/auth/analytics.readonly'] },
  },
  // GA4 needs an explicit list of property IDs; without it the integration
  // can't sync. Skip registration when unset so daemons in environments
  // that don't use GA don't surface a tool that always errors.
  preflight: async () => {
    const props = getSecret('GA_PROPERTIES');
    if (!props?.trim()) {
      throw new Error('GA_PROPERTIES env var required (comma-separated property IDs)');
    }
  },
  sync,
  tools: [createGaRecentTool],
};
