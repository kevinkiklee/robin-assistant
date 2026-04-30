// Migration 0015: create user-data/memory/self-improvement/predictions.md
// from the skeleton if the file is absent.
//
// Idempotent: if the file already exists (with any content, including user
// predictions), this migration is a no-op. Never overwrites existing data.
//
// Reversible: delete the file. The backup is the only reverse for pure
// creations.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const id = '0015-create-predictions';
export const description = 'Create predictions.md from skeleton if absent (idempotent).';

const SKELETON_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../skeleton/memory/self-improvement/predictions.md',
);

export async function up({ workspaceDir }) {
  const target = join(workspaceDir, 'user-data/memory/self-improvement/predictions.md');

  if (existsSync(target)) {
    console.log(`[${id}] predictions.md already exists — no-op`);
    return;
  }

  const skeleton = readFileSync(SKELETON_PATH, 'utf8');
  writeFileSync(target, skeleton);
  console.log(`[${id}] created predictions.md from skeleton`);
}
