// Migration 0007: rename user-data/jobs/fetch-finances.md to sync-lunch-money.md.
// Update the inline `name:` and `command:` fields to match the new convention.
// Idempotent.

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const id = '0007-rename-fetch-finances';
export const description = 'Rename fetch-finances job to sync-lunch-money and point command at user-data/scripts/.';

export async function up({ workspaceDir }) {
  const oldPath = join(workspaceDir, 'user-data/jobs/fetch-finances.md');
  const newPath = join(workspaceDir, 'user-data/jobs/sync-lunch-money.md');

  if (existsSync(newPath)) {
    if (existsSync(oldPath)) {
      unlinkSync(oldPath);
      console.log('[0007] removed leftover user-data/jobs/fetch-finances.md');
    }
    return;
  }

  if (!existsSync(oldPath)) return;

  let content = readFileSync(oldPath, 'utf-8');
  content = content.replace(/^name:\s*fetch-finances\s*$/m, 'name: sync-lunch-money');
  content = content.replace(
    /^command:\s*node\s+system\/scripts\/fetch-lunch-money\.js\s*$/m,
    'command: node user-data/scripts/sync-lunch-money.js'
  );

  writeFileSync(newPath, content);
  unlinkSync(oldPath);
  console.log('[0007] renamed fetch-finances.md → sync-lunch-money.md');
}
