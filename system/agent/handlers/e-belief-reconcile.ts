import { OUTCOME_ENVELOPE_FORMAT } from '../outcome.ts';
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
        // Belief READERS — without these the conflict scan is blind to the very
        // heads/candidates it reconciles (first live Phase-B run reported
        // outcome=blocked for exactly this). resolve_belief_candidate stays
        // excluded: E proposes, it never adjudicates the queue.
        'mcp__robin__recall_belief',
        'mcp__robin__review_beliefs',
        'mcp__robin__find_entity',
        'mcp__robin__believe',
        'mcp__robin__record_correction',
      ],
      permissionMode: 'default' as const,
      maxTurns: 22, // was 20: +2 structured-output headroom (spec §B1)
      outputFormat: OUTCOME_ENVELOPE_FORMAT,
      timeoutMs: 1_800_000,
      maxBudgetUsd: 3,
    };
  },
};

register(handler);
