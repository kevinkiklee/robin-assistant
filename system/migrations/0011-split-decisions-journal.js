// Migration 0011: split decisions.md and journal.md into per-year files.
//
// Both files are append-only and grow forever. Active tier holds only the
// current year; older entries move to archive/decisions-<year>.md and
// archive/journal-<year>.md.
//
// First time this runs, it ships only the SCAFFOLDING for the split — it
// doesn't archive historical content. Actual content migration happens at
// the first prune cycle of a new calendar year (Phase 4 prune job), which
// is the natural moment to draw the line.
//
// What this migration does:
//   - Ensure user-data/memory/archive/ exists.
//   - Add a small marker file so the prune job knows the split is "live".
//
// Why split out the actual content move: doing it mid-session, mid-year
// would be surprising. Year-end is predictable; the user opts in once.
//
// Idempotent.

import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const id = '0011-split-decisions-journal';
export const description = 'Mark decisions.md and journal.md eligible for per-year split at next year-boundary prune cycle.';

const MARKER = `# Year-Split Marker

Indicates that decisions.md and journal.md should be split into per-year
files at the first prune-cycle of a new calendar year.

The prune job (\`system/jobs/prune.md\`) reads this marker. Created by
migration 0011. Safe to delete only if you want to opt out of the per-year
split.
`;

export async function up({ workspaceDir }) {
  const archiveDir = join(workspaceDir, 'user-data/memory/archive');
  mkdirSync(archiveDir, { recursive: true });

  const markerPath = join(archiveDir, '.year-split-enabled');
  if (existsSync(markerPath)) {
    console.log('[0011] year-split marker already in place — no-op');
    return;
  }
  writeFileSync(markerPath, MARKER);
  console.log('[0011] year-split marker written; prune cycle will split at next year-boundary');
}
