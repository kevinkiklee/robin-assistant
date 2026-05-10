import { sync } from './sync.js';
import { createLinearActiveIssuesTool } from './tools/linear-active-issues.js';
import { createLinearGetIssueTool } from './tools/linear-get-issue.js';

export const manifest = {
  name: 'linear',
  cadence: '1h',
  embed: true,
  capture_mode: 'upsert',
  secrets: { env_keys: ['LINEAR_API_KEY'] },
  sync,
  tools: [createLinearActiveIssuesTool, createLinearGetIssueTool],
};
