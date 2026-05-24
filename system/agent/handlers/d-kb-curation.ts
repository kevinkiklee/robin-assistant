import { join } from 'node:path';
import type { HandlerCtx, HandlerDef } from './types.ts';
import { register } from './types.ts';

/**
 * D — Knowledge-base curation (autonomous, scoped write). Edits are confined to
 * `user-data/content/knowledge/` via `cwd`; judgment-heavy cleanup the
 * deterministic biographer/dream passes can't do.
 */
export const handler: HandlerDef = {
  id: 'D',
  name: 'kb-curation',
  trigger: 'autonomous',
  build(goal: string, ctx: HandlerCtx) {
    return {
      goal,
      cwd: join(ctx.repoRoot, 'user-data', 'content', 'knowledge'),
      allowedTools: ['Read', 'Glob', 'Grep', 'Edit'],
      permissionMode: 'acceptEdits' as const,
      maxTurns: 20,
      timeoutMs: 1_800_000,
      maxBudgetUsd: 3,
    };
  },
};

register(handler);
