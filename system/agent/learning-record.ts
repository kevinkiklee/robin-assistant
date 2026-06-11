import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LearningRecord {
  handler: string;
  goal: string;
  status: string;
  outcome?: string;
  impact?: string;
  verified?: string;
  branch?: string;
  turns: number;
  costUsd: number;
  ts: string;
}

/**
 * Append a learning-loop outcome record for a handler run (spec §B2 generalizes
 * this from A-only to every autonomous handler; no-op runs are skipped by the
 * caller to avoid clutter).
 *
 * NOTE: this dir is deliberately NOT under `content/knowledge/` so `ingest-docs`
 * never indexes it into general recall — otherwise Robin's memory floods with
 * run logs. The self-improvement primer reads it directly.
 */
export function writeLearningRecord(userDataDir: string, r: LearningRecord): string {
  const dir = join(userDataDir, 'agent-runs');
  mkdirSync(dir, { recursive: true });
  const slug = r.ts.replace(/[:.]/g, '-');
  const path = join(dir, `${slug}-${r.handler}.md`);
  const body = `---
node_type: agent_run
handler: ${r.handler}
ts: ${r.ts}
status: ${r.status}
outcome: ${r.outcome ?? ''}
impact: ${r.impact ?? ''}
verified: ${r.verified ?? ''}
branch: ${r.branch ?? ''}
turns: ${r.turns}
cost_usd: ${r.costUsd}
---

# Agent run — handler ${r.handler}

**Goal:** ${r.goal}

**Status:** ${r.status}
**Outcome:** ${r.outcome ?? '(none)'} (impact: ${r.impact ?? '?'}, verified: ${r.verified ?? 'n/a'})
**Branch:** ${r.branch ?? '(none)'}
**Turns:** ${r.turns}
**Cost (USD):** ${r.costUsd}
`;
  writeFileSync(path, body);
  return path;
}
