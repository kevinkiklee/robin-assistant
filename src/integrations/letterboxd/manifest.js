import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../../runtime/home.js';
import { sync } from './sync.js';
import { createLetterboxdRecentTool } from './tools/letterboxd-recent.js';

export const manifest = {
  name: 'letterboxd',
  cadence: '1h',
  embed: true,
  capture_mode: 'upsert',
  secrets: { env_keys: [] },
  /**
   * Preflight only ensures the upload dir exists.
   * The CSV check lives in sync() so a daemon restart is not required when a
   * new file is dropped.
   */
  preflight: async () => {
    mkdirSync(join(paths().home, 'upload'), { recursive: true });
  },
  sync,
  tools: [createLetterboxdRecentTool],
};
