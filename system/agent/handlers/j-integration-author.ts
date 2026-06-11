// J — Integration authoring. "Integrate with X" → scaffolds integration.yaml +
// index.ts + tick() per the builtin pattern, in a worktree, for review (§9).
// Robin growing new senses, not just fixing code. Shares A's write-isolation
// safety model: worktree cwd, file checkpointing, and a deny callback.

import { OUTCOME_ENVELOPE_FORMAT } from '../outcome.ts';
import { denyUnsafe } from './a-self-improvement.ts';
import type { HandlerCtx, HandlerDef } from './types.ts';
import { register } from './types.ts';

export const handler: HandlerDef = {
  id: 'J',
  name: 'integration-author',
  trigger: 'on-demand',
  build(goal: string, ctx: HandlerCtx) {
    const cwd = ctx.worktree ?? ctx.repoRoot;
    return {
      goal,
      cwd,
      allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
      permissionMode: 'acceptEdits' as const,
      maxTurns: 32, // was 30: +2 structured-output headroom (spec §B1)
      outputFormat: OUTCOME_ENVELOPE_FORMAT,
      timeoutMs: 1_800_000,
      maxBudgetUsd: 5,
      loadProjectSettings: true,
      enableFileCheckpointing: true,
      canUseTool: (toolName: string, input: Record<string, unknown>) =>
        denyUnsafe(toolName, input, cwd),
    };
  },
};

register(handler);
