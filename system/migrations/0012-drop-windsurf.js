// Migration 0012: drop Windsurf scaffolding.
//
// As of 2026-04, Robin targets only frontier-model hosts. Windsurf is dropped
// per the token-optimization design (Section 4: 5 hosts only, Windsurf out).
// Cursor and Antigravity now read AGENTS.md natively, so the only pointer
// files we still emit are CLAUDE.md and GEMINI.md.
//
// Effects:
//   - Remove .windsurfrules at the repo root if present.
//   - Remove .cursorrules at the repo root if present (Cursor reads AGENTS.md
//     natively as of 2026; .cursorrules is deprecated).
//   - The platforms.js update is a code change committed alongside this
//     migration, not a runtime change.
//
// Idempotent: deletes if present, no-op otherwise.

import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const id = '0012-drop-windsurf';
export const description = 'Remove .windsurfrules and .cursorrules from the repo root (frontier-only hosts; Cursor reads AGENTS.md natively).';

export async function up({ workspaceDir }) {
  const candidates = ['.windsurfrules', '.cursorrules'];
  let removed = 0;
  for (const c of candidates) {
    const p = join(workspaceDir, c);
    if (existsSync(p)) {
      unlinkSync(p);
      removed++;
      console.log(`[0012] removed ${c}`);
    }
  }
  if (removed === 0) console.log('[0012] no legacy pointer files to remove');
}
