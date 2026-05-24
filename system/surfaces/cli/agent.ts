import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REGISTRY } from '../../agent/handlers/index.ts';
import { mcpServersForRun } from '../../agent/mcp-servers.ts';
import { type RunAgentInput, type RunAgentResult, runAgent } from '../../agent/run-agent.ts';
import { UsageLedger } from '../../agent/usage-ledger.ts';
import { closeDb, openDb, type RobinDb } from '../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../brain/memory/migrations/index.ts';
import { loadPolicies } from '../../kernel/config/load.ts';
import { dbFilePath, resolveUserDataDir } from '../../lib/paths.ts';

/** Parsed `robin agent` invocation. */
export interface AgentCliArgs {
  goal: string;
  handler: string;
  write: boolean;
  force: boolean;
  cwd?: string;
  maxTurns?: number;
  budget?: number;
}

/**
 * Parse `robin agent "<goal>" [--handler=A] [--write] [--cwd=<path>]
 * [--max-turns=N] [--budget=N] [--force]`. The goal is the first non-flag arg.
 * Default handler is 'A' when `--write` is set, else the caller must pass
 * `--handler=` explicitly (returned empty otherwise so the dispatcher can error).
 */
export function parseAgentArgs(args: string[]): AgentCliArgs {
  const flag = (prefix: string): string | undefined => {
    const found = args.find((a) => a.startsWith(prefix));
    return found?.slice(prefix.length);
  };
  const goal = args.find((a) => !a.startsWith('-')) ?? '';
  const write = args.includes('--write');
  const force = args.includes('--force');
  const handlerFlag = flag('--handler=');
  const handler = (handlerFlag ?? (write ? 'A' : '')).toUpperCase();
  const cwd = flag('--cwd=');
  const maxTurnsFlag = flag('--max-turns=');
  const budgetFlag = flag('--budget=');
  return {
    goal,
    handler,
    write,
    force,
    ...(cwd ? { cwd } : {}),
    ...(maxTurnsFlag ? { maxTurns: Number(maxTurnsFlag) } : {}),
    ...(budgetFlag ? { budget: Number(budgetFlag) } : {}),
  };
}

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

/**
 * Append a learning-loop outcome record for a handler-A run.
 *
 * NOTE: this dir is deliberately NOT under `content/knowledge/` so `ingest-docs`
 * never indexes it into general recall — otherwise Robin's memory floods with
 * code-maintenance logs (spec §10). The self-improvement primer reads it directly.
 */
export function writeLearningRecord(
  userDataDir: string,
  record: {
    goal: string;
    status: string;
    branch?: string;
    turns: number;
    costUsd: number;
    ts: string;
  },
): string {
  const dir = join(userDataDir, 'agent-runs');
  mkdirSync(dir, { recursive: true });
  const slug = record.ts.replace(/[:.]/g, '-');
  const path = join(dir, `${slug}-A.md`);
  const body = `---
node_type: agent_run
handler: A
ts: ${record.ts}
status: ${record.status}
branch: ${record.branch ?? ''}
turns: ${record.turns}
cost_usd: ${record.costUsd}
---

# Self-improvement run

**Goal:** ${record.goal}

**Status:** ${record.status}
**Branch:** ${record.branch ?? '(none)'}
**Turns:** ${record.turns}
**Cost (USD):** ${record.costUsd}
`;
  writeFileSync(path, body);
  return path;
}

/** Dependencies injected for testability — real runners get the defaults. */
export interface AgentCliDeps {
  runAgent?: typeof runAgent;
  userDataDir?: string;
  repoRoot?: string;
  now?: () => Date;
  /** Skip real git: injected by tests so worktree calls don't hit the filesystem. */
  createWorktree?: typeof createWorktree;
  pruneWorktree?: typeof pruneWorktree;
  worktreeHasChanges?: typeof worktreeHasChanges;
  log?: (msg: string) => void;
  /** Open + migrate the ledger DB. Injected by tests to avoid the real DB. */
  openLedger?: (userDataDir: string) => { ledger: UsageLedger; close: () => void };
  /** Resolve the handler's Robin MCP servers. Injected by tests to skip the build. */
  mcpServers?: typeof mcpServersForRun;
}

export interface AgentCliResult {
  status: RunAgentResult['status'] | 'error';
  message: string;
  exitCode: number;
}

function defaultOpenLedger(userDataDir: string): { ledger: UsageLedger; close: () => void } {
  const db: RobinDb = openDb(dbFilePath(userDataDir));
  // Idempotent: ensures `agent_usage` (migration 011) exists for a bare CLI run
  // even if the daemon hasn't applied migrations in this process.
  applyMigrations(db, allMigrations);
  return { ledger: new UsageLedger(db), close: () => closeDb(db) };
}

/**
 * Core of `robin agent`. Pure of `process`/`exit` so tests drive it directly with
 * a fake `runAgent` + temp dirs. Returns a structured result; the CLI shell maps
 * it to stdout/exit codes.
 */
export async function runAgentCli(
  args: string[],
  deps: AgentCliDeps = {},
): Promise<AgentCliResult> {
  const parsed = parseAgentArgs(args);
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((m: string) => process.stderr.write(`${m}\n`));
  const userDataDir = deps.userDataDir ?? resolveUserDataDir();
  const repoRoot = deps.repoRoot ?? process.cwd();
  const run = deps.runAgent ?? runAgent;
  const mkWorktree = deps.createWorktree ?? createWorktree;
  const rmWorktree = deps.pruneWorktree ?? pruneWorktree;
  const hasChanges = deps.worktreeHasChanges ?? worktreeHasChanges;
  const openLedger = deps.openLedger ?? defaultOpenLedger;
  const buildMcpServers = deps.mcpServers ?? mcpServersForRun;

  if (!parsed.goal) {
    return {
      status: 'error',
      message:
        'usage: robin agent "<goal>" [--handler=A] [--write] [--cwd=<path>] [--max-turns=N] [--budget=N]',
      exitCode: 2,
    };
  }
  if (!parsed.handler) {
    return {
      status: 'error',
      message: 'no handler: pass --handler=<A..L> (or --write to default to A)',
      exitCode: 2,
    };
  }

  const def = REGISTRY[parsed.handler];
  if (!def) {
    return {
      status: 'error',
      message: `unknown handler '${parsed.handler}' (known: ${Object.keys(REGISTRY).sort().join(', ')})`,
      exitCode: 2,
    };
  }

  // Autonomous handlers run via the detached runner, not the on-demand CLI.
  if (def.trigger === 'autonomous' && !parsed.force) {
    return {
      status: 'error',
      message: `handler ${def.id} (${def.name}) is autonomous — it runs via the detached runner, not 'robin agent'. Use --force to override.`,
      exitCode: 2,
    };
  }

  // Build the handler input once to learn its permission mode (write vs read).
  // Write handlers (acceptEdits) need a throwaway worktree; read handlers don't.
  const probe = def.build(parsed.goal, { repoRoot });
  const isWrite = probe.permissionMode === 'acceptEdits';

  let worktree: string | undefined;
  let branch: string | undefined;
  if (isWrite && !parsed.cwd) {
    try {
      const wt = mkWorktree(repoRoot, now);
      worktree = wt.worktree;
      branch = wt.branch;
      log(`worktree: ${worktree} (branch ${branch})`);
    } catch (err) {
      return {
        status: 'error',
        message: `failed to create worktree: ${err instanceof Error ? err.message : String(err)}`,
        exitCode: 1,
      };
    }
  }

  // Handlers resolve `cwd = ctx.worktree ?? ctx.repoRoot`. An explicit --cwd wins
  // over the auto-worktree; otherwise the write-worktree (if any) becomes the cwd.
  const effectiveWorktree = parsed.cwd ?? worktree;
  const ctx = {
    repoRoot,
    ...(effectiveWorktree ? { worktree: effectiveWorktree } : {}),
  };
  const built = def.build(parsed.goal, ctx);
  // Wire Robin's own MCP servers for any mcp__robin__* / mcp__robin-extension__*
  // tool the handler allows; built-in-only handlers (e.g. A) get an empty map.
  const mcpServers = buildMcpServers(built.allowedTools, { repoRoot, userDataDir });
  const input: RunAgentInput = {
    ...built,
    surface: 'agentic-on-demand',
    mcpServers,
    ...(parsed.maxTurns ? { maxTurns: parsed.maxTurns } : {}),
    ...(parsed.budget !== undefined ? { maxBudgetUsd: parsed.budget } : {}),
  };

  const cap = loadPolicies(userDataDir).agent.caps.agentic_on_demand_daily_usd;
  const { ledger, close } = openLedger(userDataDir);

  let result: RunAgentResult;
  try {
    result = await run(input, {
      ledger,
      cap,
      transcriptDir: join(userDataDir, 'agent-runs'),
      now,
    });
  } finally {
    close();
  }

  log(`status: ${result.status}  turns: ${result.turns}  cost: $${result.costUsd.toFixed(4)}`);
  if (result.summary) log(result.summary);

  // Write-handler reporting: leave the branch for review; prune only if untouched.
  if (worktree && branch) {
    let changed = true;
    try {
      changed = hasChanges(worktree);
    } catch {
      changed = true; // if we can't tell, keep the worktree
    }
    if (changed) {
      log(`branch ${branch} left for review — diff: git -C ${worktree} diff`);
    } else {
      rmWorktree(repoRoot, worktree, branch);
      log(`no changes — pruned worktree ${worktree} + branch ${branch}`);
      branch = undefined;
    }
  }

  // Learning loop (spec §10): only handler A appends an outcome record.
  if (def.id === 'A') {
    const path = writeLearningRecord(userDataDir, {
      goal: parsed.goal,
      status: result.status,
      ...(branch ? { branch } : {}),
      turns: result.turns,
      costUsd: result.costUsd,
      ts: now().toISOString(),
    });
    log(`learning record: ${path}`);
  }

  return {
    status: result.status,
    message: result.summary,
    exitCode: result.status === 'success' || result.status === 'capped' ? 0 : 1,
  };
}

/** CLI shell: parse argv tail, run the core, print, exit. */
export async function runAgentCommand(args: string[]): Promise<void> {
  const r = await runAgentCli(args);
  if (r.status === 'error' && r.message) {
    // biome-ignore lint/suspicious/noConsole: CLI output
    console.error(r.message);
  }
  process.exit(r.exitCode);
}
