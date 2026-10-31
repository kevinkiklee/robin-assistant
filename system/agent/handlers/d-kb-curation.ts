import { join } from 'node:path';
import { OUTCOME_ENVELOPE_FORMAT } from '../outcome.ts';
import { denyUnsafe } from './a-self-improvement.ts';
import type { HandlerCtx, HandlerDef } from './types.ts';
import { register } from './types.ts';

/**
 * D — Knowledge-base curation (autonomous, scoped write). Judgment-heavy cleanup
 * the deterministic biographer/dream passes can't do. Writes are confined to
 * `user-data/content/knowledge/` by the OS sandbox + `denyUnsafe` (A's model) —
 * `cwd` alone is only a default, NOT a boundary: acceptEdits approves edits at
 * any path, and a live run escaped into ~/.claude on 2026-07-16.
 */
export const handler: HandlerDef = {
  id: 'D',
  name: 'kb-curation',
  trigger: 'autonomous',
  build(goal: string, ctx: HandlerCtx) {
    const cwd = join(ctx.repoRoot, 'user-data', 'content', 'knowledge');
    return {
      goal,
      cwd,
      allowedTools: ['Read', 'Glob', 'Grep', 'Edit'],
      permissionMode: 'acceptEdits' as const,
      maxTurns: 22, // was 20: +2 structured-output headroom (spec §B1)
      outputFormat: OUTCOME_ENVELOPE_FORMAT,
      timeoutMs: 1_800_000,
      maxBudgetUsd: 3,
      // Fail-closed OS confinement of every write (Edit, Bash mv/tee/…) to cwd;
      // the canUseTool below is the secondary, tool-level guard.
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
