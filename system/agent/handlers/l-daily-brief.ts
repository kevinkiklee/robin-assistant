// L — Agentic daily brief. Autonomous, read-only synthesis across integrations +
// memory in a loop, vs the current template (§9). Reverses 16ab0a4 ("remove
// claude -p — compose the brief in-session"), now sanctioned through runAgent.
// `plan` permission mode keeps the run read-only; the allowlist is all read
// surfaces (recall + integration reads).

import { OUTCOME_ENVELOPE_FORMAT } from '../outcome.ts';
import type { HandlerCtx, HandlerDef } from './types.ts';
import { register } from './types.ts';

/** Read-only surfaces the brief synthesizes across: memory recall + integrations. */
const BRIEF_TOOLS = [
  'mcp__robin__recall',
  'mcp__robin-extension__gmail',
  'mcp__robin-extension__google_calendar',
  'mcp__robin-extension__linear',
];

export const handler: HandlerDef = {
  id: 'L',
  name: 'daily-brief',
  trigger: 'autonomous',
  build(goal: string, ctx: HandlerCtx) {
    return {
      goal,
      cwd: ctx.repoRoot,
      allowedTools: [...BRIEF_TOOLS],
      permissionMode: 'plan' as const,
      maxTurns: 22, // was 20: +2 structured-output headroom (spec §B1)
      outputFormat: OUTCOME_ENVELOPE_FORMAT,
      timeoutMs: 1_800_000,
      maxBudgetUsd: 3,
    };
  },
};

register(handler);
