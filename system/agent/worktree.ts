import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Create a throwaway git worktree off `main`, on a fresh `agent/<ts>` branch.
 * Write handlers edit only inside this dir, so a run can never touch the live
 * checkout. Returns the worktree path + branch name for the caller to report.
 */
export function createWorktree(
  repoRoot: string,
  now: () => Date = () => new Date(),
): { worktree: string; branch: string } {
  const ts = now().toISOString().replace(/[:.]/g, '-');
  const branch = `agent/${ts}`;
  const worktree = join(repoRoot, '.worktrees', ts);
  execFileSync('git', ['-C', repoRoot, 'worktree', 'add', worktree, '-b', branch, 'main'], {
    stdio: 'pipe',
  });
  return { worktree, branch };
}

/** Remove a worktree + its branch. Only called when a run produced no changes. */
export function pruneWorktree(repoRoot: string, worktree: string, branch: string): void {
  try {
    execFileSync('git', ['-C', repoRoot, 'worktree', 'remove', '--force', worktree], {
      stdio: 'pipe',
    });
  } catch {
    // best-effort
  }
  try {
    execFileSync('git', ['-C', repoRoot, 'branch', '-D', branch], { stdio: 'pipe' });
  } catch {
    // best-effort — branch may not exist if the add failed mid-way
  }
}

/** True when the worktree has staged/unstaged changes relative to its branch base. */
export function worktreeHasChanges(worktree: string): boolean {
  const out = execFileSync('git', ['-C', worktree, 'status', '--porcelain'], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  return out.trim().length > 0;
}
