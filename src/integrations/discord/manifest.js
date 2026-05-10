import { start } from './start.js';
import { stop } from './stop.js';

export const manifest = {
  name: 'discord',
  cadence: null,
  embed: false,
  capture_mode: 'insert-or-skip',
  secrets: {
    env_keys: [
      'DISCORD_BOT_TOKEN',
      'DISCORD_APPLICATION_ID',
      'DISCORD_ALLOWED_USER_IDS',
      'DISCORD_ALLOWED_GUILD_IDS',
    ],
  },
  start,
  stop,
  tools: [],
};
