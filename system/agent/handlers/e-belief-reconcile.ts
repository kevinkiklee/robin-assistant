import type { HandlerCtx, HandlerDef } from './types.ts';
import { register } from './types.ts';

/**
 * E — Belief & entity reconciliation (autonomous, propose-only). Hunts
 * contradictions in the memory graph, traces conflicting claims to their source
 * events, and proposes merges/corrections. `believe` writes into
 * `belief_candidates` and never auto-promotes — that guard lives in the tool,
 * not here — so this run is safe to fire unattended.
 */
export const handler: HandlerDef = {
  id: 'E',
  name: 'belief-reconcile',
  trigger: 'autonomous',
  build(goal: string, ctx: HandlerCtx) {
    return {
      goal,
      cwd: ctx.repoRoot,
      allowedTools: [
        'mcp__robin__recall',
        'mcp__robin__find_entity',
        'mcp__robin__believe',
        'mcp__robin__record_correction',
      ],
      permissionMode: 'default' as const,
      maxTurns: 20,
      timeoutMs: 1_800_000,
      maxBudgetUsd: 3,
    };
  },
};

register(handler);
