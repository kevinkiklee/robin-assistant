import { getSecret } from '../../secrets/dotenv-io.js';
import { sync } from './sync.js';
import { createWhoopRecentTool } from './tools/whoop-recent.js';
import { createWhoopTodayTool } from './tools/whoop-today.js';

const REQUIRED_KEYS = ['WHOOP_REFRESH_TOKEN', 'WHOOP_CLIENT_ID', 'WHOOP_CLIENT_SECRET'];

export const manifest = {
  name: 'whoop',
  cadence: '30m',
  embed: true,
  capture_mode: 'upsert',
  secrets: {
    env_keys: REQUIRED_KEYS,
    oauth: {
      provider: 'whoop',
      scopes: [
        'read:recovery',
        'read:cycles',
        'read:sleep',
        'read:workout',
        'read:profile',
        'read:body_measurement',
        'offline',
      ],
    },
  },
  // Whoop overnight recovery scores finalize between 4-9am local; a 30m
  // cadence outside that window is wasted polling. The framework's
  // adjustForQuietWindow advances next_run_at past the quiet hours after
  // each successful sync.
  quiet_window: { tz: 'America/New_York', active_hours: [4, 5, 6, 7, 8] },
  preflight: async () => {
    const missing = REQUIRED_KEYS.filter((k) => !getSecret(k));
    if (missing.length > 0) {
      throw new Error(`missing secrets: ${missing.join(', ')} (run: robin auth whoop)`);
    }
  },
  sync,
  tools: [createWhoopRecentTool, createWhoopTodayTool],
};
