// Migration 0010: scaffold the cold-storage archive tree.
//
// Creates:
//   user-data/memory/archive/                — archive root
//   user-data/memory/archive/INDEX.md        — Tier 3 catalog (one row per
//                                              archived bucket; bounded growth)
//
// Phase 4 will populate this with pruned content. Phase 2 just creates the
// scaffolding so AGENTS.md can reference it from the Tier 1 pointer table.
//
// Idempotent: leaves an existing archive/INDEX.md alone.

import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const id = '0010-archive-scaffolding';
export const description = 'Scaffold user-data/memory/archive/ + archive/INDEX.md for cold-storage lifecycle (Phase 4 prune populates).';

const INDEX_TEMPLATE = `---
description: Cold storage catalog — pruned content. One row per archived bucket. Maintained by the prune job.
type: reference
---

# Archive Index

Pruned content. Active memory holds the last 12 months; older content moves
here. One row per archived bucket — keeps this index compact even after
years of accumulation.

The prune job (\`system/jobs/prune.md\`, default disabled) populates this.
Until first prune, this file is empty.

| year | path | summary |
|------|------|---------|
`;

export async function up({ workspaceDir }) {
  const archiveDir = join(workspaceDir, 'user-data/memory/archive');
  const indexPath = join(archiveDir, 'INDEX.md');

  mkdirSync(archiveDir, { recursive: true });

  if (existsSync(indexPath)) {
    console.log('[0010] archive/INDEX.md already exists — leaving alone');
    return;
  }

  writeFileSync(indexPath, INDEX_TEMPLATE);
  console.log('[0010] created archive/ + archive/INDEX.md');
}
