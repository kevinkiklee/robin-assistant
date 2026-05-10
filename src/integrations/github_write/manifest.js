import { createGitHubWriteTool } from './tools/github-write.js';

export const manifest = {
  name: 'github_write',
  cadence: null,
  embed: true,
  capture_mode: 'insert-or-skip',
  secrets: { env_keys: ['GITHUB_PAT'] },
  tools: [createGitHubWriteTool],
};
