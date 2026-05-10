import { existsSync } from 'node:fs';
import { lrcCatalogPath } from './client.js';
import { sync } from './sync.js';
import { createLrcSummaryTool } from './tools/lrc-summary.js';

export const manifest = {
  name: 'lrc',
  cadence: '1w',
  embed: true,
  capture_mode: 'upsert',
  secrets: { env_keys: [] },
  preflight: async () => {
    const path = lrcCatalogPath();
    if (!path) {
      throw new Error(
        'LRC_CATALOG_PATH env var required (e.g. ~/Pictures/Lightroom/MyCatalog.lrcat)',
      );
    }
    if (!existsSync(path)) throw new Error(`source not found: ${path}`);
  },
  sync,
  tools: [createLrcSummaryTool],
};
