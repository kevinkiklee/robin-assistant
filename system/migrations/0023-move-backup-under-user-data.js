// Migration 0023: move backup/ under user-data/.
//
// Backup snapshots (created by `npm run backup`, prune, and migration
// pre-flight) used to live at the workspace root. They belong with the rest
// of the personal data tree, so this migration relocates the directory to
// user-data/backup/. Same gitignore coverage (user-data/ is gitignored) and
// the path layout becomes consistent with user-data/artifacts/.
//
// Idempotent: no-op if backup/ doesn't exist.
// Reversible via down().
//
// Merge semantics (not pure rename): the migration runner makes a fresh
// pre-migration tarball under user-data/backup/ BEFORE this migration runs,
// so the destination already contains a file. We move entries one-by-one
// from backup/ into user-data/backup/, refusing on any name collision.

import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';

export const id = '0023-move-backup-under-user-data';
export const description = 'Move backup/ under user-data/.';

function moveAllEntries(src, dst, dir) {
  if (!existsSync(src)) return 0;
  mkdirSync(dst, { recursive: true });
  const entries = readdirSync(src);
  let moved = 0;
  for (const name of entries) {
    const target = join(dst, name);
    if (existsSync(target)) {
      throw new Error(
        `[${id}] cannot ${dir}: ${join(src, name)} → ${target} already exists; manual reconciliation required`,
      );
    }
    renameSync(join(src, name), target);
    moved++;
  }
  // Best-effort: remove now-empty source.
  try { rmdirSync(src); } catch { /* ignored if not empty */ }
  return moved;
}

export async function up({ workspaceDir }) {
  const oldDir = join(workspaceDir, 'backup');
  const newDir = join(workspaceDir, 'user-data/backup');

  if (!existsSync(oldDir)) {
    console.log(`[${id}] backup/ does not exist — no-op`);
    return;
  }
  const moved = moveAllEntries(oldDir, newDir, 'up');
  console.log(`[${id}] moved ${moved} entries from backup/ → user-data/backup/`);
}

export async function down({ workspaceDir }) {
  const oldDir = join(workspaceDir, 'backup');
  const newDir = join(workspaceDir, 'user-data/backup');

  if (!existsSync(newDir)) {
    console.log(`[${id}] user-data/backup/ does not exist — no-op`);
    return;
  }
  const moved = moveAllEntries(newDir, oldDir, 'down');
  console.log(`[${id}] moved ${moved} entries from user-data/backup/ → backup/`);
}
