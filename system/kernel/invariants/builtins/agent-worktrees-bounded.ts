import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Invariant } from '../types.ts';

/** Warn when more than this many agent worktrees are awaiting review. */
const DEFAULT_WARN_COUNT = 5;

/**
 * Each agentic run that produced changes leaves a throwaway worktree under
 * `<repoRoot>/.worktrees/<timestamp>` on a `agent/<timestamp>` branch for
 * human review. They are never auto-deleted (they are review material), so
 * without periodic housekeeping they silently pile up. Warn when the count
 * exceeds the threshold; no `repair()` — deleting review artifacts is a human
 * decision.
 *
 * Threshold is injectable so tests stay fast.
 */
export function agentWorktreesBoundedInvariant(
  repoRoot: string,
  opts: { warnCount?: number } = {},
): Invariant {
  const warnCount = opts.warnCount ?? DEFAULT_WARN_COUNT;
  const worktreesDir = join(repoRoot, '.worktrees');
  return {
    name: 'agent.worktrees_bounded',
    severity: 'warning',
    symptom:
      'Agent worktrees awaiting review accumulate under .worktrees/; each holds a git worktree + branch that consumes disk space and clutters `git worktree list`.',
    cause:
      'Agentic runs that produced changes leave their worktree in place for human review. Without periodic cleanup they pile up indefinitely.',
    fix: 'Review each pending worktree and merge or discard it: `git -C <repoRoot> worktree list`. Remove with `git worktree remove <path> && git branch -D agent/<ts>`.',
    check: () => {
      try {
        if (!existsSync(worktreesDir)) return { ok: true };
        let entries: string[];
        try {
          entries = readdirSync(worktreesDir).filter((e) => {
            try {
              return statSync(join(worktreesDir, e)).isDirectory();
            } catch {
              return false;
            }
          });
        } catch {
          // unreadable directory — fail-open
          return { ok: true, message: 'could not read .worktrees/ (permission error)' };
        }
        const count = entries.length;
        if (count <= warnCount) return { ok: true };
        const oldest = entries.slice().sort()[0];
        return {
          ok: false,
          message: `${count} agent worktrees awaiting review under .worktrees/ (oldest: ${oldest})`,
          remediation: `review + merge or delete: git -C ${repoRoot} worktree list; git worktree remove <path> && git branch -D agent/<ts>`,
        };
      } catch {
        // unexpected fs error — fail-open so a stale worktrees dir never blocks the doctor
        return { ok: true, message: 'unexpected error reading .worktrees/ — skipped' };
      }
    },
    // No repair() — kept worktrees are review material; deleting them is a human decision.
  };
}
