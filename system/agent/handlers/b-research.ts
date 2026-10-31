import { OUTCOME_ENVELOPE_FORMAT } from '../outcome.ts';
import type { HandlerCtx, HandlerDef } from './types.ts';
import { register } from './types.ts';

/**
 * B — Deep research (autonomous). Web + Read, plus exactly ONE write surface:
 * the `ingest` MCP action, so research briefs land in memory as events instead
 * of dying in stderr (spec §B3, deliberate permission change — ingested briefs
 * flow through the normal biographer/hygiene pipeline, never directly into
 * beliefs). NOT plan mode: the SDK evaluates plan mode before allowedTools, so
 * an allowlisted MCP write tool is still blocked there; `default` mode with all
 * write builtins denied gives the same read-only guarantee structurally.
 */
export const handler: HandlerDef = {
  id: 'B',
  name: 'research',
  trigger: 'autonomous',
  build(goal: string, ctx: HandlerCtx) {
    return {
      goal,
      cwd: ctx.repoRoot,
      allowedTools: ['WebSearch', 'WebFetch', 'Read', 'mcp__robin-extension__ingest'],
      disallowedTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'KillBash'],
      permissionMode: 'default' as const,
      maxTurns: 22, // was 20: +2 structured-output headroom (spec §B1)
      timeoutMs: 1_800_000,
      maxBudgetUsd: 3,
      outputFormat: OUTCOME_ENVELOPE_FORMAT,
    };
  },
};

register(handler);
