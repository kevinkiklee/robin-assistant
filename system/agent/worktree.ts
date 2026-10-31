import { execFileSync } from 'node:child_process';
import { existsSync, symlinkSync } from 'node:fs';
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
  // A fresh worktree has no node_modules, so a handler that wants to run tests
  // had to `cd` back into the live checkout to do it — which is how K ended up
  // editing and committing on main (2026-10-02). Share the repo's deps instead;
  // `.gitignore` matches the symlink (`node_modules`, no trailing slash).
  const deps = join(repoRoot, 'node_modules');
  if (existsSync(deps)) {
    try {
      symlinkSync(deps, join(worktree, 'node_modules'), 'dir');
    } catch {
      // best-effort — the run still works, it just can't run tests
    }
  }
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

/**
 * True when the worktree has uncommitted changes OR commits ahead of `main`. A
 * handler that commits its fix leaves a clean status, and checking status alone
 * read that as "no work" — the runner then pruned the branch, deleting the commit.
 */
export function worktreeHasChanges(worktree: string): boolean {
  const out = execFileSync('git', ['-C', worktree, 'status', '--porcelain'], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (out.trim().length > 0) return true;
  const ahead = execFileSync('git', ['-C', worktree, 'rev-list', '--count', 'main..HEAD'], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  return Number.parseInt(ahead.trim(), 10) > 0;
}

/** An agent worktree still holding unreviewed work, with the files it touches. */
export interface PendingWorktree {
  worktree: string;
  branch: string;
  files: string[];
}

/**
 * Agent worktrees (`agent/*` branches) that still hold changes awaiting the operator's
 * review, each with its changed paths (uncommitted + committed ahead of `main`).
 * The runner reads this before starting a write handler: K could not see
 * unmerged branches, so it re-fixed the same files run after run (10/2026: 16
 * pending worktrees, reliability-audit.ts patched 4×). Worktrees that are clean,
 * prunable, or unreadable are skipped — this feeds backpressure, so it fails
 * open rather than blocking a run on a broken entry.
 */
export function pendingReviewWorktrees(repoRoot: string): PendingWorktree[] {
  const listing = execFileSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  const out: PendingWorktree[] = [];
  for (const block of listing.split(/\n\n+/)) {
    const lines = block.split('\n');
    const worktree = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
    const ref = lines.find((l) => l.startsWith('branch '))?.slice('branch '.length);
    if (!worktree || !ref?.startsWith('refs/heads/agent/')) continue;
    if (lines.some((l) => l.startsWith('prunable'))) continue;
    try {
      const status = execFileSync('git', ['-C', worktree, 'status', '--porcelain'], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
      const committed = execFileSync(
        'git',
        ['-C', worktree, 'diff', '--name-only', 'main...HEAD'],
        { encoding: 'utf8', stdio: 'pipe' },
      );
      const files = new Set<string>();
      for (const l of status.split('\n')) {
        // `XY path` or `XY old -> new` — keep the post-rename path.
        const p = l.slice(3).split(' -> ').pop()?.trim();
        if (p) files.add(p);
      }
      for (const l of committed.split('\n')) if (l.trim()) files.add(l.trim());
      if (files.size > 0) {
        out.push({ worktree, branch: ref.slice('refs/heads/'.length), files: [...files].sort() });
      }
    } catch {
      // unreadable worktree — not counted
    }
  }
  return out;
}

/** The live checkout's `main` commit, or null when it can't be read. */
export function mainHead(repoRoot: string): string | null {
  try {
    return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'refs/heads/main'], {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  } catch {
    return null;
  }
}
