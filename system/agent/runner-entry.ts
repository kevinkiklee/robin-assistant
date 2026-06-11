import { join } from 'node:path';
import { latestLearningDigest } from '../brain/cognition/dream.ts';
import { closeDb, openDb, type RobinDb } from '../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../brain/memory/migrations/index.ts';
import { loadPolicies } from '../kernel/config/load.ts';
import { recordAlert, resolveAlert } from '../kernel/runtime/alert-store.ts';
import { dbFilePath, resolveUserDataDir } from '../lib/paths.ts';
import { REGISTRY } from './handlers/index.ts';
import { writeLearningRecord } from './learning-record.ts';
import { mcpServersForRun } from './mcp-servers.ts';
import { parseOutcomeEnvelope } from './outcome.ts';
import { type RunAgentInput, type RunAgentResult, runAgent } from './run-agent.ts';
import { UsageLedger } from './usage-ledger.ts';
import { verifyOutcome } from './verifiers.ts';
import {
  createWorktree as realCreateWorktree,
  pruneWorktree as realPruneWorktree,
  worktreeHasChanges as realWorktreeHasChanges,
} from './worktree.ts';

/**
 * Default goal prompt per autonomous handler. The detached runner has no caller
 * to supply a goal, so each handler gets a stable, self-describing brief. Kept
 * deliberately short — the handler's own `build()` already constrains tools,
 * permission mode, and budget; this is just the task framing.
 */
const DEFAULT_GOALS: Record<string, string> = {
  B: 'Pick the most valuable open research thread for Robin and produce a concise, sourced brief. When the brief is ready, SAVE it by calling the robin-extension `ingest` tool with kind="research.brief", source="agent:B", and the full brief markdown as `content` — an un-ingested brief is lost work.',
  D: 'Curate the knowledge base: fix stale, duplicated, or low-quality notes in scope.',
  E: 'Detect CROSS-TOPIC conflicts — contradictions between beliefs on different topics or between a belief and an entity relation (same-topic cannot conflict; supersession already guarantees one live head per topic). Propose resolutions only: write belief candidates or record corrections; never auto-promote or directly overwrite beliefs.',
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
  /** Open + migrate the ledger DB. Injected by tests to avoid the real DB. The
   * same `db` handle backs the learning digest, verifiers, and alert store. */
  openLedger?: (userDataDir: string) => { ledger: UsageLedger; db: RobinDb; close: () => void };
  /** Resolve the handler's Robin MCP servers. Injected by tests to skip the build. */
  mcpServers?: typeof mcpServersForRun;
  /** Skip real git: injected by tests so worktree calls don't hit the filesystem. */
  createWorktree?: typeof realCreateWorktree;
  pruneWorktree?: typeof realPruneWorktree;
  worktreeHasChanges?: typeof realWorktreeHasChanges;
}

export interface RunnerEntryResult {
  status: RunAgentResult['status'] | 'error';
  message: string;
  exitCode: number;
}

function defaultOpenLedger(userDataDir: string): {
  ledger: UsageLedger;
  db: RobinDb;
  close: () => void;
} {
  const db: RobinDb = openDb(dbFilePath(userDataDir));
  // Idempotent: ensures `agent_usage` (migration 011) + outcome columns (025) +
  // `alerts` (024) exist for a bare runner invocation even if the daemon hasn't
  // applied migrations in this process.
  applyMigrations(db, allMigrations);
  return { ledger: new UsageLedger(db), db, close: () => closeDb(db) };
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

  const cap = loadPolicies(userDataDir).agent.caps.agentic_autonomous_daily_usd;
  const mkWorktree = deps.createWorktree ?? realCreateWorktree;
  const rmWorktree = deps.pruneWorktree ?? realPruneWorktree;
  const hasChanges = deps.worktreeHasChanges ?? realWorktreeHasChanges;
  // One handle for the whole run: ledger writes, learning digest, deterministic
  // verifiers, and the mismatch alert all share it. Closed once in the finally.
  const { ledger, db, close } = openLedger(userDataDir);
  try {
    // Inject the latest learning digest so the handler knows Robin's current
    // performance state: calibration, belief lifecycle, recent corrections, and
    // any failed runs. This closes the feedback loop — handlers no longer start
    // from scratch each time. A digest failure degrades gracefully.
    const baseGoal = parsed.goal ?? DEFAULT_GOALS[def.id] ?? `Run autonomous handler ${def.id}.`;
    let digest: string | null = null;
    try {
      digest = latestLearningDigest(db);
    } catch {
      // Digest unavailable — handler runs without it.
    }
    const goal = digest
      ? `${baseGoal}\n\n--- ROBIN LEARNING DIGEST (your current state) ---\n${digest}`
      : baseGoal;

    // Write handlers whose cwd is the repo root edit code — isolate them in a
    // throwaway worktree exactly like `robin agent` does (spec §B3: K's verifier
    // is "worktree branch exists with a diff"). D/G write only to the gitignored
    // knowledge dir (cwd != repoRoot) and need no worktree. build() output config
    // is independent of goal content, so the baseGoal probe is sufficient.
    const probe = def.build(baseGoal, { repoRoot });
    let worktree: string | undefined;
    let branch: string | undefined;
    if (probe.permissionMode === 'acceptEdits' && probe.cwd === repoRoot) {
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

    const built = def.build(goal, { repoRoot, ...(worktree ? { worktree } : {}) });
    // Give the run Robin's own MCP servers for any mcp__robin__* / mcp__robin-extension__*
    // tool in the handler's allowlist; built-in-only handlers get an empty map.
    const mcpServers = buildMcpServers(built.allowedTools, { repoRoot, userDataDir });
    const runStartIso = now().toISOString();
    const input: RunAgentInput = {
      ...built,
      surface: 'agentic-autonomous',
      mcpServers,
      label: def.id,
    };

    const result: RunAgentResult = await run(input, {
      ledger,
      cap,
      transcriptDir: join(userDataDir, 'agent-runs'),
      now,
    });

    log(
      `handler: ${def.id} (${def.name})  status: ${result.status}  turns: ${result.turns}  cost: $${result.costUsd.toFixed(4)}`,
    );
    if (result.summary) log(result.summary);

    // Worktree disposition first (K): keep a branch with changes for review,
    // prune otherwise. Done before verification so the kept `branch` is reported.
    if (worktree && branch) {
      let worktreeChanged = false;
      try {
        worktreeChanged = hasChanges(worktree);
      } catch {
        worktreeChanged = true; // can't tell → keep for inspection
      }
      if (worktreeChanged) {
        log(`branch ${branch} left for review — diff: git -C ${worktree} diff`);
      } else {
        rmWorktree(repoRoot, worktree, branch);
        branch = undefined;
      }
    }

    // Structured outcome → ledger columns (spec §B2). Best-effort: outcome
    // bookkeeping must never turn a completed run into a failure.
    const envelope = parseOutcomeEnvelope(result.structured);
    const outcome = envelope?.outcome ?? 'unparseable';
    let verified: string | undefined;
    if (envelope?.outcome === 'did-work') {
      const v = verifyOutcome(def.id, {
        db,
        runStartIso,
        knowledgeDir: join(userDataDir, 'content', 'knowledge'),
        ...(worktree ? { worktree } : {}),
        worktreeHasChanges: hasChanges,
      });
      verified = v === 'pass' ? 'verified' : v === 'fail' ? 'outcome-mismatch' : 'unverifiable';
      if (verified === 'outcome-mismatch') {
        try {
          recordAlert(db, {
            severity: 'warning',
            source: 'agent-runner',
            key: `outcome-mismatch:${def.id}`,
            message: `handler ${def.id} claimed did-work but its verifier found no evidence`,
          });
        } catch {
          // alerting never breaks the runner
        }
      }
      if (verified === 'verified') {
        try {
          // A confirmed run clears any lingering mismatch alert for this handler —
          // symmetric with the bench-clear model (alerts resolve on observed recovery).
          resolveAlert(db, 'agent-runner', `outcome-mismatch:${def.id}`);
        } catch {
          /* alerting never breaks the runner */
        }
      }
    }
    if (result.ledgerId !== undefined) {
      try {
        ledger.recordOutcome(result.ledgerId, {
          outcome,
          ...(envelope?.impact ? { impact: envelope.impact } : {}),
          ...(result.structured !== undefined
            ? { structuredJson: JSON.stringify(result.structured) }
            : {}),
          ...(verified ? { verified } : {}),
        });
      } catch {
        // best-effort
      }
    }

    // Learning record for every autonomous handler except no-ops and pre-flight
    // caps (spec §B2). ledgerId === undefined means the SDK was never spawned —
    // the pre-flight cap short-circuited before any work happened, so there is
    // nothing meaningful to record.
    if (outcome !== 'no-op' && result.ledgerId !== undefined) {
      try {
        const path = writeLearningRecord(userDataDir, {
          handler: def.id,
          goal: baseGoal,
          status: result.status,
          outcome,
          ...(envelope?.impact ? { impact: envelope.impact } : {}),
          ...(verified ? { verified } : {}),
          ...(branch ? { branch } : {}),
          turns: result.turns,
          costUsd: result.costUsd,
          ts: runStartIso,
        });
        log(`learning record: ${path}`);
      } catch {
        // best-effort
      }
    }

    return {
      status: result.status,
      message: result.summary,
      exitCode: result.status === 'success' || result.status === 'capped' ? 0 : 1,
    };
  } finally {
    close();
  }
}

// Allow direct invocation via `tsx system/agent/runner-entry.ts --handler=B`.
// This is exactly how the detached agent-runner job spawns it.
if (import.meta.url === `file://${process.argv[1]}`) {
  void runRunnerEntry(process.argv.slice(2)).then((r) => {
    process.exit(r.exitCode);
  });
}
