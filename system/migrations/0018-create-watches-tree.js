// Migration 0018: scaffold the watches sub-tree in user-data.
//
// Creates:
//   user-data/memory/watches/   (with INDEX.md and log.md from skeleton)
//   user-data/state/watches/    (dedup state dir for watch-topics job)
//
// Idempotent: individual path checks guard each file/dir creation.
// Reversible: delete the directories. The migration backup is the only
//   reverse for pure creations.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const id = '0018-create-watches-tree';
export const description =
  'Scaffold user-data/memory/watches/ and user-data/state/watches/ from skeleton (idempotent).';

const SKELETON_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../skeleton/memory/watches',
);

function ensureDir(path) {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
    return true;
  }
  return false;
}

function copyIfMissing(src, dest, label) {
  if (existsSync(dest)) {
    console.log(`[${id}] ${label} already exists — no-op`);
    return false;
  }
  const content = readFileSync(src, 'utf8');
  writeFileSync(dest, content);
  console.log(`[${id}] created ${label}`);
  return true;
}

export async function up({ workspaceDir }) {
  // 1. Create user-data/memory/watches/
  const watchesMemDir = join(workspaceDir, 'user-data/memory/watches');
  const memCreated = ensureDir(watchesMemDir);
  if (memCreated) {
    console.log(`[${id}] created user-data/memory/watches/`);
  } else {
    console.log(`[${id}] user-data/memory/watches/ already exists`);
  }

  // 2. Copy INDEX.md from skeleton
  copyIfMissing(
    join(SKELETON_DIR, 'INDEX.md'),
    join(watchesMemDir, 'INDEX.md'),
    'user-data/memory/watches/INDEX.md',
  );

  // 3. Copy log.md from skeleton
  copyIfMissing(
    join(SKELETON_DIR, 'log.md'),
    join(watchesMemDir, 'log.md'),
    'user-data/memory/watches/log.md',
  );

  // 4. Create user-data/state/watches/
  const watchesStateDir = join(workspaceDir, 'user-data/state/watches');
  const stateCreated = ensureDir(watchesStateDir);
  if (stateCreated) {
    console.log(`[${id}] created user-data/state/watches/`);
  } else {
    console.log(`[${id}] user-data/state/watches/ already exists`);
  }
}
