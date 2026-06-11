import { OUTCOME_ENVELOPE_FORMAT } from '../outcome.ts';
import type { HandlerCtx, HandlerDef } from './types.ts';
import { register } from './types.ts';

/**
 * B — Deep research (autonomous, read-only). Web + Read only, `plan` permission
 * mode so the run can never write. Returns a synthesized brief for ingestion.
 */
export const handler: HandlerDef = {
  id: 'B',
  name: 'research',
  trigger: 'autonomous',
  build(goal: string, ctx: HandlerCtx) {
    return {
      goal,
      // No repo write surface — `plan` mode keeps it read-only regardless.
      cwd: ctx.repoRoot,
      allowedTools: ['WebSearch', 'WebFetch', 'Read'],
      permissionMode: 'plan' as const,
      maxTurns: 22, // was 20: +2 structured-output headroom (spec §B1)
      outputFormat: OUTCOME_ENVELOPE_FORMAT,
      timeoutMs: 1_800_000,
      maxBudgetUsd: 3,
    };
  },
};

register(handler);
