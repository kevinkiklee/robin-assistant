// I — General life-executor [hard risk gate].
//
// The external life tools (Resy, Uber, Uber Eats, Maps) are NOT in this static
// allowlist: they are wired in at runtime via `mcpServers`. This handler only
// declares the always-present Robin extension life tools.
//
// Per spec §11 this is the highest-blast-radius handler: it must NEVER run
// autonomously, and every irreversible action (bookings, sends, payments)
// requires explicit confirmation. That gate is enforced at the CLI/MCP surface
// (watched `robin agent` invocation + `checkOutbound` discretion), NOT here —
// the handler config is intentionally just a tool-scope + permission mode.

import { OUTCOME_ENVELOPE_FORMAT } from '../outcome.ts';
import type { HandlerCtx, HandlerDef } from './types.ts';
import { register } from './types.ts';

/**
 * Robin's always-present extension life tools. External life tools (Resy/Uber/
 * Uber Eats/Maps) are threaded at runtime via `mcpServers`, not listed here.
 * `default` permission mode keeps outbound writes flowing through Robin's
 * existing `checkOutbound` discretion check.
 */
const LIFE_TOOLS = [
  'mcp__robin-extension__gmail',
  'mcp__robin-extension__google_calendar',
  'mcp__robin-extension__spotify_write',
];

export const handler: HandlerDef = {
  id: 'I',
  name: 'life-executor',
  trigger: 'on-demand',
  build(goal: string, ctx: HandlerCtx) {
    return {
      goal,
      cwd: ctx.repoRoot,
      allowedTools: [...LIFE_TOOLS],
      permissionMode: 'default' as const,
      maxTurns: 27, // was 25: +2 structured-output headroom (spec §B1)
      outputFormat: OUTCOME_ENVELOPE_FORMAT,
      timeoutMs: 1_800_000,
      maxBudgetUsd: 5,
    };
  },
};

register(handler);
