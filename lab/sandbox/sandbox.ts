// lab/sandbox/sandbox.ts
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { registerDbInit } from '../../system/brain/memory/db.ts';
import { setClock } from '../../system/lib/clock.ts';
import { pinSqlClock } from '../../system/lib/sql-clock.ts';
import { installEgressGuard, installPathGuard, LAB_ALLOWED_HOSTS } from './guards.ts';
import { detectLivePaths } from './live-paths.ts';

export interface Sandbox {
  root: string;
  userDataDir: string;
  dbPath: string;
  env: Record<string, string>;
  dispose(): void;
}

export interface SimClock {
  now(): number;
  set(ms: number): void;
  advanceDays(days: number): void;
  advanceMs(ms: number): void;
}

const PASSTHROUGH_KEYS = ['PATH', 'CLAUDE_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY'];
const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

export function createSimClock(startMs: number): SimClock {
  let t = startMs;
  return {
    now: () => t,
    set: (ms) => {
      t = ms;
    },
    advanceDays: (days) => {
      t += days * 86_400_000;
    },
    advanceMs: (ms) => {
      t += ms;
    },
  };
}

const MARKER = '.robin-lab-sandbox';

function sandboxAt(root: string): Sandbox {
  const userDataDir = join(root, 'user-data');
  const env: Record<string, string> = {
    ROBIN_USER_DATA_DIR: userDataDir,
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'home', '.config'),
    XDG_DATA_HOME: join(root, 'home', '.local', 'share'),
    TZ: 'America/New_York',
  };
  for (const k of PASSTHROUGH_KEYS) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  return {
    root,
    userDataDir,
    dbPath: join(userDataDir, 'state', 'db', 'robin.sqlite'),
    env,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function createSandbox(opts: { root?: string } = {}): Sandbox {
  let root: string;
  if (opts.root) {
    root = resolve(opts.root);
    mkdirSync(root, { recursive: true });
    if (readdirSync(root).length > 0) throw new Error(`sandbox root not empty: ${root}`);
  } else {
    root = mkdtempSync(join(tmpdir(), 'robin-lab-'));
  }
  const sb = sandboxAt(root);
  for (const d of ['state/db', 'state/runtime', 'content/knowledge', 'content/profile', 'config']) {
    mkdirSync(join(sb.userDataDir, d), { recursive: true });
  }
  mkdirSync(join(root, 'home'), { recursive: true });
  writeFileSync(join(root, MARKER), '');
  return sb;
}

/** Re-attach to a sandbox a previous copy-day created (one process per sim-day). */
export function reopenSandbox(root: string): Sandbox {
  if (!existsSync(join(root, MARKER))) throw new Error(`not a lab sandbox: ${root}`);
  return sandboxAt(root);
}

/**
 * Make this process a lab copy: live paths are detected from the REAL env
 * first, then process.env is replaced by the sandbox allowlist, and the path
 * guard, egress guard, sim clock and SQLite clock hook are installed. Returns
 * exit(), which restores everything (used by tests; lab workers just exit).
 */
export function enterSandbox(
  sb: Sandbox,
  clock: SimClock,
  opts: { repoRoot?: string; livePaths?: string[] } = {},
): () => void {
  // Resolve live paths from the REAL env before it is swapped (or take the controller's list).
  const live = opts.livePaths ?? detectLivePaths(opts.repoRoot ?? REPO_ROOT);
  const savedEnv = { ...process.env };
  const undos: (() => void)[] = [];
  // Every undo runs in its own try/catch and env is always restored; the first
  // undo error is rethrown afterwards.
  const unwind = () => {
    let first: unknown;
    let failed = false;
    for (const u of undos.splice(0).reverse()) {
      try {
        u();
      } catch (err) {
        if (!failed) {
          failed = true;
          first = err;
        }
      }
    }
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, savedEnv);
    if (failed) throw first;
  };
  try {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, sb.env);
    undos.push(installPathGuard(live));
    undos.push(installEgressGuard(LAB_ALLOWED_HOSTS));
    undos.push(registerDbInit((db) => pinSqlClock(db, () => clock.now())));
    setClock(() => clock.now());
    undos.push(() => setClock(null));
  } catch (err) {
    try {
      unwind();
    } catch {
      // the original install error wins
    }
    throw err;
  }
  let exited = false;
  return () => {
    if (exited) return;
    exited = true;
    unwind();
  };
}
