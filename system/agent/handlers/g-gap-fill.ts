import { join } from 'node:path';
import { OUTCOME_ENVELOPE_FORMAT } from '../outcome.ts';
import { denyUnsafe } from './a-self-improvement.ts';
import type { HandlerCtx, HandlerDef } from './types.ts';
import { register } from './types.ts';

/**
 * G — Knowledge-gap → research → fill (autonomous, scoped write). A composition
 * of B (research) + D (write knowledge), triggered by a memory-gap signal: an
 * entity referenced often but thinly known. Web tools gather evidence, then
 * writes are confined to `user-data/content/knowledge/` by the OS sandbox +
 * `denyUnsafe` (A's model — cwd alone is a default, not a boundary). The
 * autonomous-learning flywheel.
 */
export const handler: HandlerDef = {
  id: 'G',
  name: 'gap-fill',
  trigger: 'autonomous',
  build(goal: string, ctx: HandlerCtx) {
    const cwd = join(ctx.repoRoot, 'user-data', 'content', 'knowledge');
    return {
      goal,
      cwd,
      // Research-then-write union: B's web tools + D's scoped read/write tools.
      allowedTools: ['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep', 'Edit'],
      permissionMode: 'acceptEdits' as const,
      maxTurns: 27, // was 25: +2 structured-output headroom (spec §B1)
      outputFormat: OUTCOME_ENVELOPE_FORMAT,
      timeoutMs: 1_800_000,
      maxBudgetUsd: 4,
      // Fail-closed OS confinement of every write to cwd; canUseTool is the
      // secondary, tool-level guard. Web tools run in the CLI process and are
      // unaffected by the command sandbox.
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        failIfUnavailable: true,
      },
      canUseTool: (toolName: string, input: Record<string, unknown>) =>
        denyUnsafe(toolName, input, cwd),
    };
  },
};

register(handler);
