// Migration 0008: split self-improvement.md into per-section files.
//
// Before: user-data/memory/self-improvement.md (monolith with H2 sections).
// After:  user-data/memory/self-improvement/{corrections,preferences,
//         calibration,session-handoff,communication-style,domain-confidence,
//         learning-queue}.md
//
// The split is needed for tier classification — only volatile sections
// (session-handoff, learning-queue) and stable behavior-shaping sections
// (communication-style, domain-confidence) belong in Tier 1. The rest move
// to Tier 2 (on-demand).
//
// Idempotent: if the split files already exist, this is a no-op.
// Reversible: concat the split files back. The migration leaves the
// original at .self-improvement.md.pre-0008 for safety (auto-cleaned by
// system-maintenance after 90 days).

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const id = '0008-split-self-improvement';
export const description = 'Split user-data/memory/self-improvement.md into per-section files for tier classification.';

const SECTIONS = [
  { heading: 'Corrections', file: 'corrections.md' },
  { heading: 'Preferences', file: 'preferences.md' },
  { heading: 'Calibration', file: 'calibration.md' },
  { heading: 'Session Handoff', file: 'session-handoff.md' },
  { heading: 'Communication Style', file: 'communication-style.md' },
  { heading: 'Domain Confidence', file: 'domain-confidence.md' },
  { heading: 'Learning Queue', file: 'learning-queue.md' },
];

const FRONTMATTER = (heading) => `---
description: ${heading} — split from self-improvement.md by migration 0008.
type: topic
---

# ${heading}

`;

function parseSections(content) {
  // Split on H2 (## Heading) lines. Returns map heading -> body.
  const lines = content.split('\n');
  const sections = new Map();
  let currentHeading = null;
  let currentBody = [];

  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      if (currentHeading !== null) {
        sections.set(currentHeading, currentBody.join('\n').trim());
      }
      currentHeading = m[1].trim();
      currentBody = [];
    } else if (currentHeading !== null) {
      currentBody.push(line);
    }
  }
  if (currentHeading !== null) {
    sections.set(currentHeading, currentBody.join('\n').trim());
  }
  return sections;
}

export async function up({ workspaceDir }) {
  const monolith = join(workspaceDir, 'user-data/memory/self-improvement.md');
  const splitDir = join(workspaceDir, 'user-data/memory/self-improvement');

  // Idempotency check: if all split files exist, we're done.
  const allSplitsExist = SECTIONS.every((s) => existsSync(join(splitDir, s.file)));
  if (allSplitsExist) {
    console.log('[0008] split files already exist — no-op');
    return;
  }

  if (!existsSync(monolith)) {
    // Fresh workspace — create empty split files from frontmatter only.
    mkdirSync(splitDir, { recursive: true });
    for (const s of SECTIONS) {
      const target = join(splitDir, s.file);
      if (!existsSync(target)) {
        writeFileSync(target, FRONTMATTER(s.heading));
      }
    }
    console.log('[0008] created empty split files (no monolith found)');
    return;
  }

  const content = readFileSync(monolith, 'utf-8');
  const sections = parseSections(content);

  mkdirSync(splitDir, { recursive: true });
  for (const s of SECTIONS) {
    const target = join(splitDir, s.file);
    if (existsSync(target)) continue;
    const body = sections.get(s.heading) ?? '';
    writeFileSync(target, FRONTMATTER(s.heading) + body + (body ? '\n' : ''));
  }

  // Stash the monolith with a marker name so it can be reconstructed if
  // anything goes wrong. system-maintenance.md cleans these up after 90 days.
  const stash = monolith + '.pre-0008';
  if (!existsSync(stash)) renameSync(monolith, stash);
  console.log('[0008] split self-improvement.md into 7 files; original stashed at .pre-0008');
}
