// Migration 0014: seed user-data/memory/self-improvement/learning-queue.md
// with starter questions IF the file has no entries yet.
//
// Canonical question source: this migration AND
// system/skeleton/memory/self-improvement/learning-queue.md.
// Keep both in sync.
//
// Idempotent: only seeds when the file has no `### ` entries.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const id = '0014-seed-learning-queue';
export const description = 'Seed Learning Queue with starter questions if empty (idempotent).';

const SEED_QUESTIONS = `### 2026-04-30 — Best work time of day
- domain: scheduling
- why: tailor when to surface focus-heavy items
- status: open

### 2026-04-30 — Decisions to flag vs decide autonomously
- domain: ask-vs-act
- why: calibrate the operational rule on the user's actual preference
- status: open

### 2026-04-30 — Detail level for finance >$1k
- domain: stress-test
- why: hard rule says stress-test these; depth depends on user
- status: open

### 2026-04-30 — Tolerance for prediction-style claims being saved + checked back
- domain: outcome-learning
- why: gates whether outcome-check job (X1) should be enabled
- status: open

### 2026-04-30 — Signals for "deep work" sessions
- domain: capture-sweep
- why: when to defer vs when to interrupt
- status: open

### 2026-04-30 — Style: verbal-style match vs explicit
- domain: communication-style
- why: low-priority but improves daily feel
- status: open

### 2026-04-30 — Promote corrections to AGENTS.md vs keep as patterns
- domain: self-improvement
- why: hard rules are sticky; patterns are revisable
- status: open
`;

export async function up({ workspaceDir }) {
  const file = join(workspaceDir, 'user-data/memory/self-improvement/learning-queue.md');
  if (!existsSync(file)) {
    console.log(`[${id}] file missing — no-op`);
    return;
  }
  const text = readFileSync(file, 'utf8');
  if (/^### /m.test(text)) {
    console.log(`[${id}] file has entries — no-op`);
    return;
  }
  const sep = text.endsWith('\n') ? '' : '\n';
  writeFileSync(file, `${text}${sep}\n${SEED_QUESTIONS}`);
  const count = SEED_QUESTIONS.match(/^### /gm).length;
  console.log(`[${id}] seeded ${count} starter questions`);
}
