// Migration 0019: create policies.md, action-trust.md, and pending-asks.md
// from the scaffold if absent.
//
// Idempotent: existing files (any content) are not touched. Reversible
// by deleting the created files.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const id = '0019-create-action-state-files';
export const description =
  'Create policies.md, action-trust.md, and pending-asks.md from the scaffold (idempotent).';

const SCAFFOLD_DIR = join(dirname(fileURLToPath(import.meta.url)), '../scaffold');

// Scaffold sources moved to the post-0021 layout (ops/config, ops/state/turn).
// Destinations remain at the pre-0021 paths because 0019 runs BEFORE 0021;
// migration 0021 then reorganizes user-data/ to match scaffold.
const TARGETS = [
  { src: 'ops/config/policies.md', dst: 'user-data/policies.md' },
  {
    src: 'memory/self-improvement/action-trust.md',
    dst: 'user-data/memory/self-improvement/action-trust.md',
  },
  { src: 'ops/state/turn/pending-asks.md', dst: 'user-data/state/pending-asks.md' },
];

export async function up({ workspaceDir }) {
  for (const t of TARGETS) {
    const target = join(workspaceDir, t.dst);
    if (existsSync(target)) {
      console.log(`[${id}] ${t.dst} already exists — no-op`);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    const scaffoldPath = join(SCAFFOLD_DIR, t.src);
    const content = readFileSync(scaffoldPath, 'utf8');
    writeFileSync(target, content);
    console.log(`[${id}] created ${t.dst} from scaffold`);
  }
}
