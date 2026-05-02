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

// Sources match the current scaffold layout (post-0022: runtime/).
// Destinations use the post-0022 user-data layout. On a fresh install, 0019
// writes directly to runtime/* paths; when 0021 and 0022 run afterward, their
// existsSync(src) checks at the prior paths fail and they no-op gracefully
// for these files. On older installs that already ran 0019 at pre-0021
// destinations, 0019 is recorded applied and doesn't re-run; 0021 + 0022
// then move the pre-0021 files to the new layout in the normal way.
const TARGETS = [
  { src: 'runtime/config/policies.md', dst: 'user-data/runtime/config/policies.md' },
  {
    src: 'memory/self-improvement/action-trust.md',
    dst: 'user-data/memory/self-improvement/action-trust.md',
  },
  { src: 'runtime/state/turn/pending-asks.md', dst: 'user-data/runtime/state/turn/pending-asks.md' },
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
