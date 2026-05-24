import { join } from 'node:path';
import type { HandlerCtx, HandlerDef } from './types.ts';
import { register } from './types.ts';

/**
 * G — Knowledge-gap → research → fill (autonomous, scoped write). A composition
 * of B (research) + D (write knowledge), triggered by a memory-gap signal: an
 * entity referenced often but thinly known. Web tools gather evidence, then
 * writes are confined to `user-data/content/knowledge/` via `cwd`. The
 * autonomous-learning flywheel.
 */
export const handler: HandlerDef = {
  id: 'G',
  name: 'gap-fill',
  trigger: 'autonomous',
  build(goal: string, ctx: HandlerCtx) {
    return {
      goal,
      cwd: join(ctx.repoRoot, 'user-data', 'content', 'knowledge'),
      // Research-then-write union: B's web tools + D's scoped read/write tools.
      allowedTools: ['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep', 'Edit'],
      permissionMode: 'acceptEdits' as const,
      maxTurns: 25,
      timeoutMs: 1_800_000,
      maxBudgetUsd: 4,
    };
  },
};

register(handler);
