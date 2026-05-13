import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { photoCollectionDir, sync } from './sync.js';
import { createPhotosRecentTool } from './tools/photos-recent.js';

// EXIF metadata sweep of ~/Photography/Collection/ (or PHOTO_COLLECTION_DIR).
// Cursor tracks the highest mtime seen — re-runs only touch files modified
// since the last pass. Capture mode is `upsert` so a re-edited photo
// (mtime bumps, but path is unchanged) replaces its event instead of
// silently dedup-skipping.
//
// Preflight requires the collection dir AND a working `exiftool` binary —
// the daemon surfaces this as `unavailable` if either is missing.
export const manifest = {
  name: 'photos',
  cadence: '6h',
  embed: true,
  capture_mode: 'upsert',
  secrets: { env_keys: [] },
  preflight: async () => {
    const dir = photoCollectionDir();
    if (!existsSync(dir)) {
      throw new Error(`source not found: ${dir} (set PHOTO_COLLECTION_DIR)`);
    }
    try {
      execFileSync('exiftool', ['-ver'], { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch {
      throw new Error('exiftool binary not on PATH (install: brew install exiftool)');
    }
  },
  sync,
  tools: [createPhotosRecentTool],
};
