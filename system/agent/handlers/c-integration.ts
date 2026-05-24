import type { HandlerCtx, HandlerDef } from './types.ts';
import { register } from './types.ts';

/**
 * Robin's own extension MCP tools this handler is scoped to. Outbound-write
 * discretion is enforced at the integration layer (`checkOutbound`), not here —
 * `default` permission mode lets those writes pass through that existing check.
 */
const EXTENSION_TOOLS = [
  'mcp__robin-extension__gmail',
  'mcp__robin-extension__google_calendar',
  'mcp__robin-extension__linear',
  'mcp__robin-extension__chrome',
];

/** C — Multi-step integration tasks (on-demand) over Robin's extension MCP. */
export const handler: HandlerDef = {
  id: 'C',
  name: 'integration',
  trigger: 'on-demand',
  build(goal: string, ctx: HandlerCtx) {
    return {
      goal,
      cwd: ctx.repoRoot,
      allowedTools: [...EXTENSION_TOOLS],
      permissionMode: 'default' as const,
      maxTurns: 25,
      timeoutMs: 1_800_000,
      maxBudgetUsd: 4,
    };
  },
};

register(handler);
