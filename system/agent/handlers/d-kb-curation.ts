import { join } from 'node:path';
import { OUTCOME_ENVELOPE_FORMAT } from '../outcome.ts';
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
      maxTurns: 22, // was 20: +2 structured-output headroom (spec §B1)
      outputFormat: OUTCOME_ENVELOPE_FORMAT,
      timeoutMs: 1_800_000,
      maxBudgetUsd: 3,
    };
  },
};

register(handler);
