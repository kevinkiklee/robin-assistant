import type { HandlerCtx, HandlerDef } from './types.ts';
import { register } from './types.ts';

/**
 * H — Dream enrichment (autonomous, propose-only). Cross-session synthesis that
 * connects events across time into higher-order insight, iterating over the
 * event corpus rather than one-shotting a window like the deterministic `dream`
 * job. Proposes via `believe` into the review queue; never auto-writes beliefs.
 */
export const handler: HandlerDef = {
  id: 'H',
  name: 'dream-enrich',
  trigger: 'autonomous',
  build(goal: string, ctx: HandlerCtx) {
    return {
      goal,
      cwd: ctx.repoRoot,
      allowedTools: ['mcp__robin__recall', 'mcp__robin__journal', 'mcp__robin__believe'],
      permissionMode: 'default' as const,
      maxTurns: 20,
      timeoutMs: 1_800_000,
      maxBudgetUsd: 3,
    };
  },
};

register(handler);
