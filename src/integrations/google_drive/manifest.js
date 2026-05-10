import { sync } from './sync.js';
import { createDriveGetFileTool } from './tools/drive-get-file.js';
import { createDriveSearchTool } from './tools/drive-search.js';

export const manifest = {
  name: 'google_drive',
  cadence: '4h',
  embed: true,
  capture_mode: 'upsert',
  secrets: {
    env_keys: [
      'GOOGLE_OAUTH_REFRESH_TOKEN',
      'GOOGLE_OAUTH_CLIENT_ID',
      'GOOGLE_OAUTH_CLIENT_SECRET',
    ],
  },
  sync,
  tools: [createDriveSearchTool, createDriveGetFileTool],
};
