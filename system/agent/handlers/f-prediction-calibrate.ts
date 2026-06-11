import { OUTCOME_ENVELOPE_FORMAT } from '../outcome.ts';
import type { HandlerCtx, HandlerDef } from './types.ts';
import { register } from './types.ts';

/**
 * F — Prediction resolution + calibration (autonomous). Reviews open
 * predictions, gathers evidence via read-only web + the extension's
 * `resolve_prediction` action, resolves them, and reports calibration drift.
 * Closes the predict→learn loop nothing else closes today.
 */
export const handler: HandlerDef = {
  id: 'F',
  name: 'prediction-calibrate',
  trigger: 'autonomous',
  build(goal: string, ctx: HandlerCtx) {
    return {
      goal,
      cwd: ctx.repoRoot,
      allowedTools: [
        'mcp__robin__recall',
        'mcp__robin__predict',
        'mcp__robin-extension__resolve_prediction',
        'WebSearch',
        'WebFetch',
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
