// Migration 0007: rename fetch-finances → sync-lunch-money.
//
// Two effects, both idempotent:
//   1. Rename user-data/jobs/fetch-finances.md → sync-lunch-money.md
//      (and update inline `name:` and `command:` fields).
//   2. Migrate user-data/state/lunch-money-sync.json → user-data/state/sync/lunch-money.json
//      (the new script reads from a different location with a different shape).

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const id = '0007-rename-fetch-finances';
export const description = 'Rename fetch-finances job to sync-lunch-money; migrate state file shape and location.';

function migrateJobDef(workspaceDir) {
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

function migrateStateFile(workspaceDir) {
  const oldPath = join(workspaceDir, 'user-data/state/lunch-money-sync.json');
  const newPath = join(workspaceDir, 'user-data/state/sync/lunch-money.json');

  if (existsSync(newPath)) {
    if (existsSync(oldPath)) {
      unlinkSync(oldPath);
      console.log('[0007] removed leftover user-data/state/lunch-money-sync.json');
    }
    return;
  }
  if (!existsSync(oldPath)) return;

  let old;
  try {
    old = JSON.parse(readFileSync(oldPath, 'utf-8'));
  } catch (err) {
    // Quarantine the corrupt file so the migration converges on next run
    // (instead of failing forever on the same parse error).
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const quarantine = `${oldPath}.corrupt-${stamp}`;
    try {
      renameSync(oldPath, quarantine);
      console.log(`[0007] corrupt old state at ${oldPath} (${err.message}); quarantined to ${quarantine}`);
    } catch (renameErr) {
      console.log(`[0007] corrupt old state at ${oldPath} (${err.message}); rename failed (${renameErr.message})`);
    }
    return;
  }

  const next = {
    last_attempt_at: old.last_run_at ?? null,
    last_success_at: old.last_run_at ?? null,
    last_sync_date: old.last_sync ?? null,
    error_count: 0,
    last_error: null,
    auth_status: 'ok',
    cursor: { transactions_pulled: old.transactions_pulled ?? 0 },
  };

  mkdirSync(dirname(newPath), { recursive: true });
  writeFileSync(newPath, JSON.stringify(next, null, 2) + '\n');
  unlinkSync(oldPath);
  console.log('[0007] migrated state file → user-data/state/sync/lunch-money.json');
}

export async function up({ workspaceDir }) {
  migrateJobDef(workspaceDir);
  migrateStateFile(workspaceDir);
}
