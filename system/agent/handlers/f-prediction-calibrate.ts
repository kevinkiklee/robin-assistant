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
      maxTurns: 20,
      timeoutMs: 1_800_000,
      maxBudgetUsd: 3,
    };
  },
};

register(handler);
