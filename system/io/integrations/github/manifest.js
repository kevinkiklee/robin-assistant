import { sync } from './sync.js';
import { createGithubNotificationsTool } from './tools/github-notifications.js';
import { createGithubRecentActivityTool } from './tools/github-recent-activity.js';

export const manifest = {
  name: 'github',
  cadence: '1h',
  embed: true,
  capture_mode: 'insert-or-skip',
  secrets: { env_keys: ['GITHUB_PAT'] },
  sync,
  tools: [createGithubRecentActivityTool, createGithubNotificationsTool],
};
