import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sync } from './sync.js';
import { createChromeRecentVisitsTool } from './tools/chrome-recent-visits.js';
import { createChromeTopDomainsTool } from './tools/chrome-top-domains.js';

/**
 * Default Chrome history path on macOS. CHROME_HISTORY_PATH overrides for
 * non-default profiles, alternate Chromium browsers, or test fixtures.
 */
export function chromeHistoryPath() {
  return (
    process.env.CHROME_HISTORY_PATH ??
    join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'History')
  );
}

export const manifest = {
  name: 'chrome',
  cadence: '1d',
  embed: true,
  capture_mode: 'insert-or-skip',
  secrets: { env_keys: [] },
  preflight: async () => {
    const path = chromeHistoryPath();
    if (!existsSync(path)) {
      throw new Error(
        `source not found: ${path} (set CHROME_HISTORY_PATH if Chrome history is elsewhere)`,
      );
    }
  },
  sync,
  tools: [createChromeRecentVisitsTool, createChromeTopDomainsTool],
};
