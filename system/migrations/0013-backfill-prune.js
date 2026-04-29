// Migration 0013: backfill prune for transactions older than 12 months.
//
// This migration is GATED — it does nothing unless explicitly enabled by
// the prune job's first confirmed run. The migration runner records it as
// applied so it doesn't fire repeatedly, but the actual archival happens
// inside `system/jobs/prune.md`'s first run with --confirm.
//
// Why a migration: the migration log is the durable place to record "we
// have considered backfill". Even though the action is deferred, the
// numerical id slot reserves the work and downstream code can rely on it.
//
// Idempotent: just records intent. Phase 4 prune does the actual work.

import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const id = '0013-backfill-prune';
export const description = 'Reserve migration slot for backfill prune of >12-month-old transactions. Actual archival happens inside the prune job.';

const README = `# Backfill prune intent

Migration 0013 reserved this slot. The actual backfill happens when the
user runs:

    robin run prune --confirm

with the prune job enabled. Until then, this directory is empty.

The prune job archives transactions older than 12 months into
\`archive/transactions/<year>/\`. Original month files are moved (atomically),
not deleted. To roll back, restore from the pre-prune backup at
\`backup/<timestamp>-pre-prune/\`.
`;

export async function up({ workspaceDir }) {
  const archive = join(workspaceDir, 'user-data/memory/archive');
  mkdirSync(archive, { recursive: true });
  const intentPath = join(archive, '.backfill-prune-pending');
  if (existsSync(intentPath)) {
    console.log('[0013] backfill-prune intent already recorded — no-op');
    return;
  }
  writeFileSync(intentPath, README);
  console.log('[0013] recorded backfill-prune intent; prune job will execute on first --confirm run');
}
