import { sync } from './sync.js';
import { createNhlRecentTool } from './tools/nhl-recent.js';
import { createNhlStandingsTool } from './tools/nhl-standings.js';

export const manifest = {
  name: 'nhl',
  cadence: '12h',
  embed: true,
  capture_mode: 'upsert',
  secrets: { env_keys: [] },
  sync,
  tools: [createNhlRecentTool, createNhlStandingsTool],
};
