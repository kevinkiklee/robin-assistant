import { join } from 'node:path';
import { closeDb, openDb, type RobinDb } from '../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../brain/memory/migrations/index.ts';
import { loadPolicies } from '../kernel/config/load.ts';
import { dbFilePath, resolveUserDataDir } from '../lib/paths.ts';
import { REGISTRY } from './handlers/index.ts';
import { mcpServersForRun } from './mcp-servers.ts';
import { type RunAgentInput, type RunAgentResult, runAgent } from './run-agent.ts';
import { UsageLedger } from './usage-ledger.ts';

/**
 * Default goal prompt per autonomous handler. The detached runner has no caller
 * to supply a goal, so each handler gets a stable, self-describing brief. Kept
 * deliberately short — the handler's own `build()` already constrains tools,
 * permission mode, and budget; this is just the task framing.
 */
const DEFAULT_GOALS: Record<string, string> = {
  B: 'Pick the most valuable open research thread for Robin and produce a concise, sourced brief.',
  D: 'Curate the knowledge base: fix stale, duplicated, or low-quality notes in scope.',
  E: 'Reconcile conflicting or stale beliefs against current evidence and update confidence.',
  F: 'Calibrate open predictions: resolve any that are now decidable and adjust the rest.',
  G: 'Find the highest-value knowledge gap and fill it with a well-sourced note.',
  H: 'Enrich recent memory: surface non-obvious connections and journal a consolidation.',
  K: 'Triage the latest health report and remediate the top actionable issue safely.',
  L: "Assemble Kevin's daily brief from recent memory, calendar, and open threads.",
};

/** Parsed `--handler=<ID>` (and any future flags) for the runner entrypoint. */
export interface RunnerArgs {
  handler: string;
  goal?: string;
}

/** Parse the runner argv tail: `--handler=B [--goal="..."]`. Handler is uppercased. */
export function parseRunnerArgs(args: string[]): RunnerArgs {
  const flag = (prefix: string): string | undefined => {
    const found = args.find((a) => a.startsWith(prefix));
    return found?.slice(prefix.length);
  };
  const handler = (flag('--handler=') ?? '').toUpperCase();
  const goal = flag('--goal=');
  return { handler, ...(goal ? { goal } : {}) };
}

/** Dependencies injected for testability — the real entrypoint gets the defaults. */
export interface RunnerEntryDeps {
  runAgent?: typeof runAgent;
  userDataDir?: string;
  repoRoot?: string;
  now?: () => Date;
  log?: (msg: string) => void;
  /** Open + migrate the ledger DB. Injected by tests to avoid the real DB. */
  openLedger?: (userDataDir: string) => { ledger: UsageLedger; close: () => void };
  /** Resolve the handler's Robin MCP servers. Injected by tests to skip the build. */
  mcpServers?: typeof mcpServersForRun;
}

export interface RunnerEntryResult {
  status: RunAgentResult['status'] | 'error';
  message: string;
  exitCode: number;
}

function defaultOpenLedger(userDataDir: string): { ledger: UsageLedger; close: () => void } {
  const db: RobinDb = openDb(dbFilePath(userDataDir));
  // Idempotent: ensures `agent_usage` (migration 011) exists for a bare runner
  // invocation even if the daemon hasn't applied migrations in this process.
  applyMigrations(db, allMigrations);
  return { ledger: new UsageLedger(db), close: () => closeDb(db) };
}

/**
 * Core of the detached autonomous runner. Validates that `--handler` names an
 * AUTONOMOUS handler (on-demand handlers like 'A' run via `robin agent`, not
 * here), opens the ledger, builds the agent input with the `agentic-autonomous`
 * surface + its daily cap, and runs to completion. Pure of `process`/`exit` so
 * tests drive it with a fake `runAgent`.
 */
export async function runRunnerEntry(
  args: string[],
  deps: RunnerEntryDeps = {},
): Promise<RunnerEntryResult> {
  const parsed = parseRunnerArgs(args);
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((m: string) => process.stderr.write(`${m}\n`));
  const userDataDir = deps.userDataDir ?? resolveUserDataDir();
  const repoRoot = deps.repoRoot ?? process.cwd();
  const run = deps.runAgent ?? runAgent;
  const openLedger = deps.openLedger ?? defaultOpenLedger;
  const buildMcpServers = deps.mcpServers ?? mcpServersForRun;

  if (!parsed.handler) {
    return { status: 'error', message: 'usage: runner-entry --handler=<B..L>', exitCode: 2 };
  }

  const def = REGISTRY[parsed.handler];
  if (!def) {
    return {
      status: 'error',
      message: `unknown handler '${parsed.handler}' (known: ${Object.keys(REGISTRY).sort().join(', ')})`,
      exitCode: 2,
    };
  }

  // The detached runner is for autonomous handlers ONLY. On-demand handlers
  // (A, C, I, J) run interactively via `robin agent`.
  if (def.trigger !== 'autonomous') {
    return {
      status: 'error',
      message: `handler ${def.id} (${def.name}) is on-demand — it runs via 'robin agent', not the autonomous runner.`,
      exitCode: 2,
    };
  }

  const goal = parsed.goal ?? DEFAULT_GOALS[def.id] ?? `Run autonomous handler ${def.id}.`;
  const built = def.build(goal, { repoRoot });
  // Give the run Robin's own MCP servers for any mcp__robin__* / mcp__robin-extension__*
  // tool in the handler's allowlist; built-in-only handlers get an empty map.
  const mcpServers = buildMcpServers(built.allowedTools, { repoRoot, userDataDir });
  const input: RunAgentInput = { ...built, surface: 'agentic-autonomous', mcpServers };

  const cap = loadPolicies(userDataDir).agent.caps.agentic_autonomous_daily_usd;
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

  log(
    `handler: ${def.id} (${def.name})  status: ${result.status}  turns: ${result.turns}  cost: $${result.costUsd.toFixed(4)}`,
  );
  if (result.summary) log(result.summary);

  return {
    status: result.status,
    message: result.summary,
    exitCode: result.status === 'success' || result.status === 'capped' ? 0 : 1,
  };
}

// Allow direct invocation via `tsx system/agent/runner-entry.ts --handler=B`.
// This is exactly how the detached agent-runner job spawns it.
if (import.meta.url === `file://${process.argv[1]}`) {
  void runRunnerEntry(process.argv.slice(2)).then((r) => {
    process.exit(r.exitCode);
  });
}
