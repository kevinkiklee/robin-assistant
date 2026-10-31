// K — Health self-remediation. Trigger: an invariant trip or integration error.
// Reads health/metrics/logs, diagnoses, and either proposes a config change or
// opens a code-fix branch in a worktree (§9), sharing A's write-isolation safety
// model (worktree cwd, checkpointing, deny callback). Since 2026-10-31 a verified
// branch auto-lands on main when it clears auto-land.ts's gate (scope, size,
// test, typecheck, lint, tests); anything else still waits for review. The
// nightly reliability audit dispatches K directly via a remediation request.

import { OUTCOME_ENVELOPE_FORMAT } from '../outcome.ts';
import { denyUnsafe, WORKTREE_SANDBOX } from './a-self-improvement.ts';
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
      // 27 was exhausted on diagnose+edit before the structured-summary turn:
      // every capped K run landed at 28 turns with a null envelope (recorded
      // 'unparseable', ~50% of runs, 9/2026). Raised to 32 to match A/J, its
      // worktree code-fix peers; the $4 budget cap (runs ~$2.5) stays the hard
      // cost bound. (was 25→27 for +2 §B1 headroom, still short for this class.)
      maxTurns: 32,
      outputFormat: OUTCOME_ENVELOPE_FORMAT,
      timeoutMs: 1_800_000,
      maxBudgetUsd: 4,
      loadProjectSettings: true,
      enableFileCheckpointing: true,
      // Writes confined to the worktree — see WORKTREE_SANDBOX.
      sandbox: { ...WORKTREE_SANDBOX },
      canUseTool: (toolName: string, input: Record<string, unknown>) =>
        denyUnsafe(toolName, input, cwd),
    };
  },
};

register(handler);
