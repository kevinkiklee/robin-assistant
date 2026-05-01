// Migration 0019: create policies.md, action-trust.md, and pending-asks.md
// from skeletons if absent.
//
// Idempotent: existing files (any content) are not touched. Reversible
// by deleting the created files.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const id = '0019-create-action-state-files';
export const description =
  'Create policies.md, action-trust.md, and pending-asks.md from skeletons (idempotent).';

const SKELETON_DIR = join(dirname(fileURLToPath(import.meta.url)), '../skeleton');

const TARGETS = [
  { src: 'policies.md', dst: 'user-data/policies.md' },
  {
    src: 'memory/self-improvement/action-trust.md',
    dst: 'user-data/memory/self-improvement/action-trust.md',
  },
  { src: 'state/pending-asks.md', dst: 'user-data/state/pending-asks.md' },
];

export async function up({ workspaceDir }) {
  for (const t of TARGETS) {
    const target = join(workspaceDir, t.dst);
    if (existsSync(target)) {
      console.log(`[${id}] ${t.dst} already exists — no-op`);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    const skeletonPath = join(SKELETON_DIR, t.src);
    const skeleton = readFileSync(skeletonPath, 'utf8');
    writeFileSync(target, skeleton);
    console.log(`[${id}] created ${t.dst} from skeleton`);
  }
}
