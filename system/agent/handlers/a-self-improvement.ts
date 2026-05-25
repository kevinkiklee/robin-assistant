import { isAbsolute, relative, resolve } from 'node:path';
import type { HandlerCtx, HandlerDef } from './types.ts';
import { register } from './types.ts';

/** Bash command substrings that are never allowed in a self-improvement run. */
const FORBIDDEN_BASH = ['git push', 'git commit', 'rm -rf'];

/** Tools that write to disk and must stay inside `cwd`. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** SDK permission-callback result (allow with the unchanged input, or deny). */
type Permission =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

/** Is `target` contained within `cwd`? Resolves relative paths against `cwd`. */
function isInsideCwd(target: string, cwd: string): boolean {
  const abs = isAbsolute(target) ? resolve(target) : resolve(cwd, target);
  const rel = relative(resolve(cwd), abs);
  // Outside iff the relative path climbs out (`..`) or is itself absolute.
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Pure deny-callback core for handler A. Defense-in-depth behind the OS sandbox
 * (see `build()`), NOT the primary write-isolation guard — `canUseTool` only ever
 * sees Write/Edit tool inputs, never what a Bash command actually writes, so it
 * cannot confine Bash on its own. It denies:
 *  - Bash commands containing `git push`, `git commit`, or `rm -rf`;
 *  - Write/Edit whose target path escapes `cwd`.
 * Everything else is allowed (the coarse `allowedTools` allowlist gates the rest).
 */
export function denyUnsafe(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): Permission {
  if (toolName === 'Bash') {
    const command = String(input.command ?? '');
    if (FORBIDDEN_BASH.some((bad) => command.includes(bad))) {
      return { behavior: 'deny', message: `blocked unsafe command: ${command}` };
    }
  }

  if (WRITE_TOOLS.has(toolName)) {
    const path = typeof input.file_path === 'string' ? input.file_path : undefined;
    if (path && !isInsideCwd(path, cwd)) {
      return { behavior: 'deny', message: `blocked write outside cwd: ${path}` };
    }
  }

  return { behavior: 'allow', updatedInput: input };
}

export const handler: HandlerDef = {
  id: 'A',
  name: 'self-improvement',
  trigger: 'on-demand',
  build(goal: string, ctx: HandlerCtx) {
    const cwd = ctx.worktree ?? ctx.repoRoot;
    return {
      goal,
      cwd,
      allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
      permissionMode: 'acceptEdits' as const,
      maxTurns: 30,
      timeoutMs: 1_800_000,
      maxBudgetUsd: 5,
      loadProjectSettings: true,
      enableFileCheckpointing: true,
      // OS-level sandbox (seatbelt on macOS, bubblewrap on Linux) confines every
      // command — Bash redirections, `tee`, `cp`, `python -c`, `git -C /other`,
      // etc. — to the worktree `cwd`. This is the real enforcement of write
      // isolation; `canUseTool` below is only a secondary guard. `failIfUnavailable`
      // is fail-closed: if the host can't sandbox, the run errors rather than
      // writing unconfined and pretending to be isolated.
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
