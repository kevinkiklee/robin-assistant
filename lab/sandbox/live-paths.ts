// lab/sandbox/live-paths.ts
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { resolveUserDataDir } from '../../system/lib/paths.ts';
import { resolveForCheck } from './guards.ts';

/** If `repoRoot` is a linked git worktree, the main checkout's root (from its `.git` file). */
function mainCheckoutOf(repoRoot: string): string | undefined {
  try {
    const gitPath = join(repoRoot, '.git');
    if (statSync(gitPath).isDirectory()) return undefined;
    const m = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(gitPath, 'utf8'));
    if (!m?.[1]) return undefined;
    const gitdir = isAbsolute(m[1]) ? m[1] : resolve(repoRoot, m[1]);
    // <main>/.git/worktrees/<name> -> <main>/.git -> <main>
    return dirname(resolve(gitdir, '..', '..'));
  } catch {
    return undefined;
  }
}

/**
 * Every place the live instance's user-data could be, from the REAL environment
 * (before any sandbox swaps HOME or ROBIN_USER_DATA_DIR): the real-env override,
 * the pointer-file / XDG resolution, the XDG default even when a pointer exists,
 * <repoRoot>/user-data and the main checkout's user-data (a worktree has none).
 * Candidates are returned even when they do not exist yet; the path guard
 * resolves missing paths. Only stat/realpath-level calls are made on them.
 */
export function detectLivePaths(repoRoot: string): string[] {
  const env = { ...process.env };
  const pointerEnv = { ...env };
  delete pointerEnv.ROBIN_USER_DATA_DIR;
  const candidates: (string | undefined)[] = [
    env.ROBIN_USER_DATA_DIR,
    resolveUserDataDir({ env: pointerEnv }),
    join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'robin'),
    join(repoRoot, 'user-data'),
  ];
  const main = mainCheckoutOf(repoRoot);
  if (main) candidates.push(join(main, 'user-data'));
  const real = candidates.filter((p): p is string => !!p).map((p) => resolveForCheck(p));
  return [...new Set(real)];
}
