// K — Health self-remediation. Trigger: an invariant trip or integration error.
// Reads health/metrics/logs, diagnoses, and either proposes a config change or
// opens a code-fix branch in a worktree for review (§9). Autonomous-detect,
// human-approve — it runs unattended but only produces a reviewable diff,
// sharing A's write-isolation safety model (worktree cwd, checkpointing, deny
// callback).

import { OUTCOME_ENVELOPE_FORMAT } from '../outcome.ts';
import { denyUnsafe } from './a-self-improvement.ts';
import type { HandlerCtx, HandlerDef } from './types.ts';
import { register } from './types.ts';

export const handler: HandlerDef = {
  id: 'K',
  name: 'health-remediate',
  trigger: 'autonomous',
  build(goal: string, ctx: HandlerCtx) {
    const cwd = ctx.worktree ?? ctx.repoRoot;
    return {
      goal,
      cwd,
      allowedTools: [
        'Read',
        'Glob',
        'Grep',
        'Edit',
        'Bash',
        'mcp__robin__health',
        'mcp__robin__metrics',
      ],
      permissionMode: 'acceptEdits' as const,
      maxTurns: 27, // was 25: +2 structured-output headroom (spec §B1)
      outputFormat: OUTCOME_ENVELOPE_FORMAT,
      timeoutMs: 1_800_000,
      maxBudgetUsd: 4,
      loadProjectSettings: true,
      enableFileCheckpointing: true,
      canUseTool: (toolName: string, input: Record<string, unknown>) =>
        denyUnsafe(toolName, input, cwd),
    };
  },
};

register(handler);
