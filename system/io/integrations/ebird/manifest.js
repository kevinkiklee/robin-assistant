import { sync } from './sync.js';
import { createEbirdRecentTool } from './tools/ebird-recent.js';

export const manifest = {
  name: 'ebird',
  cadence: '12h',
  embed: true,
  capture_mode: 'insert-or-skip',
  secrets: { env_keys: ['EBIRD_API_KEY'] },
  sync,
  tools: [createEbirdRecentTool],
};
