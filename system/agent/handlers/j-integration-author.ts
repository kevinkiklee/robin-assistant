// J — Integration authoring. "Integrate with X" → scaffolds integration.yaml +
// index.ts + tick() per the builtin pattern, in a worktree, for review (§9).
// Robin growing new senses, not just fixing code. Shares A's write-isolation
// safety model: worktree cwd, file checkpointing, and a deny callback.

import type { HandlerCtx, HandlerDef } from './types.ts';
import { register } from './types.ts';
import { denyUnsafe } from './a-self-improvement.ts';

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
      maxTurns: 30,
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
