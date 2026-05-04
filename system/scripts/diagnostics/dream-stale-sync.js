#!/usr/bin/env node
// Dream-helper: scan synced files for staleness, write or clear the
// "Stale sync files" section in user-data/runtime/state/needs-your-input.md.
//
// Composes check-sync-freshness with needs-input. Designed to be invoked by
// Dream Phase 12.5 (or Phase 11.5) via a single Bash call so the agent
// doesn't have to re-implement the scan + write each cycle.
//
// Usage:
//   node system/scripts/diagnostics/dream-stale-sync.js
//
// Defaults to scanning user-data/memory/sync/, user-data/runtime/state/sync/,
// AND any *.md under user-data/memory/ that already declares last_synced.
// Appends a section per stale file (max 25 listed; remaining count noted).
// Clears the section when no stale files remain.
//
// Exit 0 always — informational only.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveCliWorkspaceDir } from '../lib/workspace-root.js';
import { scanFreshness } from './check-sync-freshness.js';
import { appendSection, clearSection } from '../lib/needs-input.js';

const SECTION_NAME = 'Stale sync files';

export function runDreamStaleSync({ workspaceDir, maxAgeHours = 24, maxListed = 25 }) {
  // Combine: explicit sync paths + any file with last_synced anywhere under
  // memory/ or runtime/state/ (catches Kevin-style layouts where synced data
  // lives under knowledge/<topic>/).
  const explicit = scanFreshness({
    workspaceDir,
    roots: ['user-data/memory/sync', 'user-data/runtime/state/sync'],
    maxAgeHours,
  });
  const allStamped = scanFreshness({
    workspaceDir,
    roots: ['user-data/memory', 'user-data/runtime/state'],
    maxAgeHours,
    onlyWithStamp: true,
  });

  // Merge stale lists by path; explicit wins on duplicates.
  const seen = new Set();
  const stale = [];
  for (const s of [...explicit.stale, ...allStamped.stale]) {
    if (seen.has(s.path)) continue;
    seen.add(s.path);
    stale.push(s);
  }
  // Missing-stamp only counts under explicit roots; if those roots are
  // empty (Kevin's case), missing is naturally 0 and that's fine.
  const missing = explicit.missing;

  if (stale.length === 0 && missing.length === 0) {
    clearSection(workspaceDir, SECTION_NAME);
    return { stale: 0, missing: 0, cleared: true };
  }

  const lines = [];
  if (stale.length > 0) {
    const shown = stale.slice(0, maxListed);
    for (const s of shown) {
      lines.push(`- ${s.path} — ${s.age_hours}h old (last_synced: ${s.last_synced})`);
    }
    if (stale.length > maxListed) {
      lines.push(`- … and ${stale.length - maxListed} more stale files`);
    }
  }
  if (missing.length > 0) {
    lines.push('');
    lines.push(`Missing \`last_synced\` (${missing.length}):`);
    for (const p of missing.slice(0, maxListed)) {
      lines.push(`- ${p}`);
    }
    if (missing.length > maxListed) {
      lines.push(`- … and ${missing.length - maxListed} more`);
    }
  }
  appendSection(workspaceDir, SECTION_NAME, `${lines.join('\n')}\n`);
  return { stale: stale.length, missing: missing.length, cleared: false };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let workspaceDir;
  try {
    workspaceDir = resolveCliWorkspaceDir();
  } catch (err) {
    process.stderr.write(`dream-stale-sync: ${err.message}\n`);
    process.exit(1);
  }
  const r = runDreamStaleSync({ workspaceDir });
  if (r.cleared) {
    process.stdout.write('dream-stale-sync: no stale syncs — section cleared\n');
  } else {
    process.stdout.write(`dream-stale-sync: ${r.stale} stale, ${r.missing} missing — section updated\n`);
  }
  process.exit(0);
}
