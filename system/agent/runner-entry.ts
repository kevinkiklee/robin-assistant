import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { latestLearningDigest } from '../brain/cognition/dream.ts';
import { closeDb, openDb, type RobinDb } from '../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../brain/memory/migrations/index.ts';
import { notifyDiscordAction } from '../integrations/builtin/discord/index.ts';
import { loadPolicies } from '../kernel/config/load.ts';
import { DEFAULT_WARN_COUNT as WORKTREE_WARN_COUNT } from '../kernel/invariants/builtins/agent-worktrees-bounded.ts';
import { recordAlert, resolveAlert } from '../kernel/runtime/alert-store.ts';
import { appendLandLog } from '../lib/land-log.ts';
import { operatorName } from '../lib/operator-profile.ts';
import { dbFilePath, resolveUserDataDir } from '../lib/paths.ts';
import { clearRemediationRequestIf } from '../lib/remediation-request.ts';
import { AUTO_LAND_LIMITS, type AutoLandResult, autoLand, restartDaemonSoon } from './auto-land.ts';
import { REGISTRY } from './handlers/index.ts';
import { writeLearningRecord } from './learning-record.ts';
import { mcpServersForRun } from './mcp-servers.ts';
import { parseOutcomeEnvelope } from './outcome.ts';
import { type RunAgentInput, type RunAgentResult, runAgent } from './run-agent.ts';
import { UsageLedger } from './usage-ledger.ts';
import { verifyOutcome } from './verifiers.ts';
import {
  type PendingWorktree,
  createWorktree as realCreateWorktree,
  mainHead as realMainHead,
  pendingReviewWorktrees as realPendingReviewWorktrees,
  pruneWorktree as realPruneWorktree,
  worktreeHasChanges as realWorktreeHasChanges,
} from './worktree.ts';

/**
 * Review backpressure for write handlers: at this many unreviewed agent
 * worktrees, skip the run instead of adding another. Mirrors the
 * `agent.worktrees_bounded` doctor threshold, so the runner can't push the
 * backlog past the point where the doctor starts warning.
 */
export const MAX_PENDING_REVIEW_WORKTREES = WORKTREE_WARN_COUNT;

/** Files listed per pending branch in the goal note — keeps the prompt small. */
const PENDING_FILES_PER_BRANCH = 8;

/**
 * Goal suffix listing what unmerged agent branches already touch, so a write
 * handler picks a different issue instead of re-fixing the same file.
 */
export function pendingReviewNote(pending: PendingWorktree[]): string {
  const rows = pending.map((p) => {
    const shown = p.files.slice(0, PENDING_FILES_PER_BRANCH).join(', ');
    const more =
      p.files.length > PENDING_FILES_PER_BRANCH
        ? ` (+${p.files.length - PENDING_FILES_PER_BRANCH} more)`
        : '';
    return `- ${p.branch}: ${shown}${more}`;
  });
  return [
    '--- PENDING REVIEW (unmerged agent branches — do NOT redo this work) ---',
    ...rows,
    `These fixes are already waiting for ${operatorName('the operator')}. If the top issue is one of them, move to the next actionable issue, or report no-op.`,
  ].join('\n');
}

/**
 * Default goal prompt per autonomous handler. The detached runner has no caller
 * to supply a goal, so each handler gets a stable, self-describing brief. Kept
 * deliberately short — the handler's own `build()` already constrains tools,
 * permission mode, and budget; this is just the task framing. `op` is the
 * operator's name from user-data/config/operator.yaml (generic when unset).
 */
const defaultGoals = (op: string): Record<string, string> => ({
  B: 'Pick the most valuable open research thread for Robin and produce a concise, sourced brief. When the brief is ready, SAVE it by calling the robin-extension `ingest` tool with kind="research.brief", source="agent:B", and the full brief markdown as `content` — an un-ingested brief is lost work.',
  D: 'Curate the knowledge base: fix stale, duplicated, or low-quality notes in scope.',
  E: 'Detect CROSS-TOPIC conflicts — contradictions between beliefs on different topics or between a belief and an entity relation (same-topic cannot conflict; supersession already guarantees one live head per topic). Propose resolutions only: write belief candidates or record corrections; never auto-promote or directly overwrite beliefs.',
  F: 'Calibrate open predictions: list them with the robin `list` tool (type="predictions"), resolve any that are now decidable with `resolve_prediction`, and adjust the rest.',
  G: 'Find the highest-value knowledge gap and fill it with a well-sourced note.',
  H: 'Enrich recent memory: surface non-obvious connections across sessions, then SAVE the consolidation by calling the robin `remember` tool with kind="memory.consolidation" — an unsaved consolidation is lost work (`journal` is read-only). Durable PERSONAL-life claims may also go through `believe`; claims about Robin/engineering internals are domain-gated and will be blocked.',
  K: `Triage the latest health report and remediate the top actionable issue safely. Your working directory is a git worktree on its own branch: make every change there and leave it uncommitted (commits are blocked), and never cd into or modify the main checkout. Add or extend a test that fails without your fix. Robin lands the branch automatically when it is small (≤${AUTO_LAND_LIMITS.maxFiles} files, ≤${AUTO_LAND_LIMITS.maxChangedLines} lines), stays inside reliability code (system/kernel/invariants, the health monitor and its helpers in system/kernel/runtime, system/kernel/scheduler, system/integrations/_runtime, system/jobs/_runtime), carries a test, and passes typecheck, lint and tests; anything else waits for ${op}'s review.`,
  L: `Assemble ${op}'s daily brief from recent memory, calendar, and open threads.`,
});

/** Parsed `--handler=<ID>` (and any future flags) for the runner entrypoint. */
export interface RunnerArgs {
  handler: string;
  goal?: string;
  /** createdAt of the remediation request this run serves (cleared on success). */
  request?: string;
}

/** Parse the runner argv tail: `--handler=B [--goal="..."]`. Handler is uppercased. */
export function parseRunnerArgs(args: string[]): RunnerArgs {
  const flag = (prefix: string): string | undefined => {
    const found = args.find((a) => a.startsWith(prefix));
    return found?.slice(prefix.length);
  };
  const handler = (flag('--handler=') ?? '').toUpperCase();
  const goal = flag('--goal=');
  const request = flag('--request=');
  return { handler, ...(goal ? { goal } : {}), ...(request ? { request } : {}) };
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
  mainHead?: typeof realMainHead;
  pendingReviewWorktrees?: typeof realPendingReviewWorktrees;
  /** Land a verified K branch. Injected by tests so no real git/build runs. */
  autoLand?: (opts: Parameters<typeof autoLand>[0]) => AutoLandResult;
  /** Post-land side effects (notify + daemon restart). Injected by tests. */
  afterLand?: (r: AutoLandResult, ctx: AfterLandCtx) => Promise<void>;
}

export interface RunnerEntryResult {
  status: RunAgentResult['status'] | 'error';
  message: string;
  exitCode: number;
}

/**
 * The repo root sits two directories above this module (`system/agent/` in dev,
 * `dist/agent/` compiled). NEVER derive it from process.cwd(): the daemon's
 * launchd WorkingDirectory is user-data, the detached child inherits it, and a
 * cwd-derived root resolved every handler path inside user-data — which killed
 * every autonomous run from ship until 2026-07-16.
 */
function defaultRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * After an auto-land attempt: a landed fix restarts the daemon onto the new
 * build and posts a silent note; a held one posts why it is waiting for review.
 * Discord-only and silent — the reliability program's rule is no push
 * notifications, so no macOS banner (notifyOperator) and no mention.
 */
export interface AfterLandCtx {
  branch: string;
  repoRoot: string;
  userDataDir: string;
}

async function defaultAfterLand(r: AutoLandResult, ctx: AfterLandCtx): Promise<void> {
  const { branch, repoRoot, userDataDir } = ctx;
  appendLandLog(userDataDir, {
    branch,
    landed: r.landed,
    reason: r.reason,
    files: r.files,
    ...(r.commit ? { commit: r.commit } : {}),
  });
  if (r.landed && r.commit) {
    restartDaemonSoon({
      repoRoot,
      commit: r.commit,
      branch,
      logPath: join(userDataDir, 'observability', 'logs', 'agent-runner.log'),
    });
  }
  await notifyDiscordAction({
    title: r.landed ? 'Robin auto-fixed an issue' : 'Robin fix held for review',
    message: r.landed ? `${r.reason}: ${r.files.join(', ')}` : `${branch} — ${r.reason}`,
    mention: false,
    silent: true,
  });
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
  const repoRoot = deps.repoRoot ?? defaultRepoRoot();
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
  let sdkRan = false;
  try {
    // Inject the latest learning digest so the handler knows Robin's current
    // performance state: calibration, belief lifecycle, recent corrections, and
    // any failed runs. This closes the feedback loop — handlers no longer start
    // from scratch each time. A digest failure degrades gracefully.
    // A caller-supplied goal (the reliability audit's findings for K) is the
    // task; the handler's default goal still rides along as its standing rules
    // (worktree-only, uncommitted, test required) so a custom task can't drop them.
    const standing = defaultGoals(operatorName('the operator'))[def.id];
    const baseGoal = parsed.goal
      ? [parsed.goal, standing].filter(Boolean).join('\n\n')
      : (standing ?? `Run autonomous handler ${def.id}.`);
    let digest: string | null = null;
    try {
      digest = latestLearningDigest(db);
    } catch {
      // Digest unavailable — handler runs without it.
    }
    let goal = digest
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
      // Review backpressure. Every K run that changes anything leaves a branch
      // for the operator; unreviewed ones were invisible to the next run, so they piled
      // up (17 by 10/19) as overlapping re-fixes of the same files. A listing
      // failure fails open — the run proceeds exactly as before.
      let pending: PendingWorktree[] = [];
      try {
        pending = (deps.pendingReviewWorktrees ?? realPendingReviewWorktrees)(repoRoot);
      } catch {
        pending = [];
      }
      if (pending.length >= MAX_PENDING_REVIEW_WORKTREES) {
        // No SDK run → no ledger row, like the pre-flight cost cap: a skip is
        // neither a failure for benching nor an outcome to score.
        const message = `review backlog: ${pending.length} agent branches await review (cap ${MAX_PENDING_REVIEW_WORKTREES}) — skipped handler ${def.id}; merge or discard them to resume (git -C ${repoRoot} worktree list)`;
        log(message);
        return { status: 'capped', message, exitCode: 0 };
      }
      if (pending.length > 0) goal = `${goal}\n\n${pendingReviewNote(pending)}`;

      // A creation failure throws into the pre-run catch below, which records
      // the error ledger row — benching must see worktree failures too.
      const wt = mkWorktree(repoRoot, now);
      worktree = wt.worktree;
      branch = wt.branch;
      log(`worktree: ${worktree} (branch ${branch})`);
    }

    const built = def.build(goal, { repoRoot, ...(worktree ? { worktree } : {}) });
    // Give the run Robin's own MCP servers for any mcp__robin__* / mcp__robin-extension__*
    // tool in the handler's allowlist; built-in-only handlers get an empty map.
    const mcpServers = buildMcpServers(built.allowedTools, { repoRoot, userDataDir });
    const runStartIso = now().toISOString();
    // Escape tripwire: a worktree run must never move the live checkout's main.
    const readMain = deps.mainHead ?? realMainHead;
    const mainBefore = worktree ? readMain(repoRoot) : null;
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
    sdkRan = true;

    log(
      `handler: ${def.id} (${def.name})  status: ${result.status}  turns: ${result.turns}  cost: $${result.costUsd.toFixed(4)}`,
    );
    if (result.summary) log(result.summary);

    // Post-run disposition (escape check + worktree prune) must NEVER sink the
    // outcome bookkeeping below. A throw here — `readMain`/`rmWorktree` hitting a
    // git lock, say — would skip `recordOutcome` and jump to the outer catch,
    // which records a SECOND 'error' ledger row while the already-recorded
    // 'success' row keeps outcome=NULL forever. That orphaned success+NULL row is
    // exactly what reliability-audit's `countAgentRunsWithoutOutcome` flags as a
    // (permanent, benign) silent miss. Guarding the whole block keeps a single
    // run to a single, fully-stamped ledger row.
    try {
      if (mainBefore) {
        const mainAfter = readMain(repoRoot);
        if (mainAfter && mainAfter !== mainBefore) {
          // K committed on main from outside its worktree on 2026-10-02; the OS
          // sandbox now blocks that, and this catches any other way out.
          log(
            `ESCAPE: main moved ${mainBefore.slice(0, 7)} → ${mainAfter.slice(0, 7)} during ${def.id}'s worktree run`,
          );
          try {
            recordAlert(db, {
              severity: 'critical',
              source: 'agent-runner',
              key: `agent-escape:${def.id}`,
              message: `handler ${def.id} ran in a worktree but main moved ${mainBefore.slice(0, 7)} → ${mainAfter.slice(0, 7)} during the run — review \`git log ${mainBefore.slice(0, 7)}..main\` (a commit of yours in that window is a false alarm)`,
            });
          } catch {
            /* alerting never breaks the runner */
          }
        }
      }

      // Worktree disposition (K): keep a branch with changes for review, prune
      // otherwise. Done before verification so the kept `branch` is reported.
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
    } catch (dispositionErr) {
      // Non-fatal: a kept branch with a diff is the safe default (K's verifier
      // still sees it), and the run continues to its outcome stamp below.
      log(
        `post-run disposition failed (non-fatal): ${
          dispositionErr instanceof Error ? dispositionErr.message : String(dispositionErr)
        }`,
      );
    }

    // Structured outcome → ledger columns (spec §B2). Best-effort: outcome
    // bookkeeping must never turn a completed run into a failure.
    const envelope = parseOutcomeEnvelope(result.structured);
    // A capped (max-turns/max-budget) or timed-out run never reaches its
    // structured-summary turn, so the envelope is absent — but that is turn/
    // time exhaustion, NOT a malformed envelope. Record it as 'incomplete' so
    // the health report can tell "ran out of budget before summarizing" (a
    // scope/capacity problem — e.g. K caps at its turn ceiling and lands
    // envelope-less on every run, 10/2026) apart from 'unparseable' (the model
    // finished but emitted missing/invalid structured output — a real
    // structured-output regression). Both still skip verification (outcome is
    // only verified when the envelope explicitly claims 'did-work').
    const outcome =
      envelope?.outcome ??
      (result.status === 'capped' || result.status === 'timeout' ? 'incomplete' : 'unparseable');
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

    // Auto-land (2026-10-31): a verified K fix lands on main without review when
    // it clears auto-land's deterministic gate; otherwise the branch stays for
    // review exactly as before. Never throws into the run's result.
    if (
      def.id === 'K' &&
      verified === 'verified' &&
      worktree &&
      branch &&
      loadPolicies(userDataDir).agent.auto_land
    ) {
      try {
        const title =
          envelope?.changes?.[0]?.summary ?? envelope?.notes ?? 'remediate health issue';
        const landed = (deps.autoLand ?? autoLand)({ repoRoot, worktree, branch, title, log });
        await (deps.afterLand ?? defaultAfterLand)(landed, { branch, repoRoot, userDataDir });
      } catch (landErr) {
        log(
          `auto-land failed (non-fatal, branch kept for review): ${
            landErr instanceof Error ? landErr.message : String(landErr)
          }`,
        );
      }
    }

    // A completed run consumes the audit's request; an errored, timed-out or
    // capped one leaves it for the runner to retry.
    if (parsed.request && result.status === 'success') {
      clearRemediationRequestIf(userDataDir, parsed.request);
    }

    return {
      status: result.status,
      message: result.summary,
      exitCode: result.status === 'success' || result.status === 'capped' ? 0 : 1,
    };
  } catch (err) {
    // A pre-run failure (worktree creation, MCP resolution, digest DB…) used to
    // escape as an unhandled rejection: no ledger row, so benching was blind to
    // a month of dead runs. Record it — but only when the SDK never ran; runAgent
    // writes exactly one row per run itself and must not get a duplicate.
    if (!sdkRan) {
      try {
        ledger.record({
          surface: 'agentic-autonomous',
          label: def.id,
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          turns: 0,
          status: 'error',
          subtype: 'pre-run',
        });
      } catch {
        // ledger write is best-effort — the error return below still lands
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    log(`handler ${def.id} failed ${sdkRan ? 'after' : 'before'} the SDK run: ${message}`);
    return { status: 'error', message, exitCode: 1 };
  } finally {
    close();
  }
}

// Allow direct invocation via `tsx system/agent/runner-entry.ts --handler=B`.
// This is exactly how the detached agent-runner job spawns it.
if (import.meta.url === `file://${process.argv[1]}`) {
  void runRunnerEntry(process.argv.slice(2))
    .then((r) => {
      process.exit(r.exitCode);
    })
    .catch((err) => {
      // Belt-and-braces: runRunnerEntry catches pre-run failures itself, so this
      // only fires on a bug in the runner — still exit nonzero, never hang.
      process.stderr.write(`runner-entry: fatal: ${err instanceof Error ? err.stack : err}\n`);
      process.exit(1);
    });
}
