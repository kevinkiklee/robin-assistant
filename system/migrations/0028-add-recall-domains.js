// Migration 0028: copy the default recall-domains.md scaffold to user-data
// if no user-edited version exists.
//
// Domain-trigger recall (system/scripts/hooks/lib/domain-recall.js) reads
// `user-data/runtime/config/recall-domains.md` to map activity keywords
// (fertilizer → garden file, IRA → finance snapshot, etc.) to memory files.
// Without this file, domain recall is a graceful no-op (only entity recall
// fires). The migration ensures existing installs pick up sensible defaults
// (fresh installs get the file via the setup.js scaffold copy).
//
// Idempotent: if the destination already exists, the migration is a no-op
// even when the user has edited it. The user owns the file once it lands.
//
// Atomic write: tmp + rename. The default content is inlined so the
// migration can run without packageRoot lookup (matches the 0014 pattern).
// Canonical default also lives at
// `system/scaffold/runtime/config/recall-domains.md` — keep both in sync.

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DEST_REL = 'user-data/runtime/config/recall-domains.md';

const DEFAULT_CONTENT = `---
description: Domain-trigger recall map. Matches user message against keywords; injects mapped memory files at session prompt time. User-editable.
type: reference
---

# Recall domains

Format: each section is a domain. Keywords are matched case-insensitive with
word boundaries. Files are injected as \`<!-- relevant memory -->\` blocks by
the \`onUserPromptSubmit\` hook (\`system/scripts/hooks/lib/domain-recall.js\`).

This is a parallel pass to entity-alias recall. Use it for activity / topic
keywords that don't match an entity name (e.g. "fertilizer" doesn't name an
entity but should still surface the rooftop garden file).

The defaults below are deliberately narrow — over-matching wastes context
budget and slows the hook. Add domains as needed; remove or narrow keywords
that fire frequently with no value (Dream Phase 11.5 surfaces dead keywords).

## gardening
keywords: garden, gardening, plant, plants, fertilizer, soil, mulch
files:
  - user-data/memory/knowledge/home/outdoor-space.md

## finance
keywords: investment, IRA, 401k, Roth, brokerage, retirement, taxes
files:
  - user-data/memory/knowledge/finance/financial-snapshot.md

## health
keywords: whoop, recovery, HRV, sleep score, strain
files:
  - user-data/memory/knowledge/health/whoop.md

## briefing freshness
keywords: today's, this morning, latest
files:
  - user-data/runtime/jobs/daily-briefing.md
`;

export const id = '0028-add-recall-domains';
export const description =
  'Copy default recall-domains.md scaffold into user-data if missing. Idempotent.';

export async function up({ workspaceDir }) {
  const dest = join(workspaceDir, DEST_REL);
  if (existsSync(dest)) {
    console.log(`[${id}] recall-domains.md already exists — no-op`);
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  writeFileSync(tmp, DEFAULT_CONTENT);
  renameSync(tmp, dest);
  console.log(`[${id}] seeded default recall-domains.md`);
}
