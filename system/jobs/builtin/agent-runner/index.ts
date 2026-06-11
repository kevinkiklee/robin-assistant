import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquire, release } from '../../../agent/single-flight.ts';
import type { RobinDb } from '../../../brain/memory/db.ts';
import { loadPolicies } from '../../../kernel/config/load.ts';
import { recordAlert, resolveAlert } from '../../../kernel/runtime/alert-store.ts';
import { resolveUserDataDir } from '../../../lib/paths.ts';
import type { Job, JobContext, JobResult } from '../../_runtime/types.ts';
import { preCheck } from './pre-checks.ts';

/**
 * The 8 autonomous handlers (spec B,D,E,F,G,H,K,L), in a fixed round-robin order.
 * One handler is dispatched per tick; the cursor advances and persists so the
 * next tick picks the following handler. A constant list (vs. reading REGISTRY)
 * keeps the order stable and the job free of handler-module import side-effects.
 */
const AUTONOMOUS_HANDLERS = ['B', 'D', 'E', 'F', 'G', 'H', 'K', 'L'] as const;

/**
 * Single-flight stale window. A detached child runs `runAgent` to completion
 * (handlers cap at a 30-min timeout), so the lock must outlive the longest run
 * plus slack. 45 min: long enough that a still-running child is never stomped,
 * short enough that a crashed child's abandoned lock is reclaimed within a tick
 * or two rather than wedging the runner for hours.
 */
const LOCK_STALE_MS = 45 * 60_000;

/** Mirrors the jobs/integrations loader: prefer compiled .js, else .ts under tsx. */
const IS_COMPILED = import.meta.url.endsWith('.js');

/** Signature of the injectable spawner — a thin subset of child_process.spawn. */
export type SpawnFn = typeof spawn;

export interface AgentRunnerDeps {
  /** Injected so tests use a fake instead of spawning a real child. */
  spawn?: SpawnFn;
  /** Absolute user-data dir; resolved from the environment when omitted. */
  userDataDir?: string;
  /** Resolves the runner-entry script path; overridable in tests. */
  runnerEntryPath?: () => string;
  /** Master kill-switch check; defaults to reading `agent.enabled` from policies. */
  isEnabled?: () => boolean;
}

/**
 * Resolve the runner-entry script next to this module: from
 * system/jobs/builtin/agent-runner/ up to system/agent/runner-entry.{js,ts}.
 * Compiled runs spawn the .js; tsx dev runs spawn the .ts.
 */
function defaultRunnerEntryPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const ext = IS_COMPILED ? 'js' : 'ts';
  return join(here, '..', '..', '..', 'agent', `runner-entry.${ext}`);
}

/** Path to the persisted round-robin cursor (a single integer). */
function cursorPath(userDataDir: string): string {
  return join(userDataDir, 'state', 'runtime', 'agent-runner-cursor');
}

/** Path to the single-flight lockfile shared with any manual runner invocation. */
function lockPath(userDataDir: string): string {
  return join(userDataDir, 'state', 'runtime', 'agent-runner.lock');
}

/** Read the persisted cursor; defaults to 0 on missing/corrupt/out-of-bounds. */
function readCursor(userDataDir: string): number {
  try {
    const n = Number.parseInt(readFileSync(cursorPath(userDataDir), 'utf8').trim(), 10);
    return Number.isFinite(n) && n >= 0 && n < AUTONOMOUS_HANDLERS.length ? n : 0;
  } catch {
    return 0;
  }
}

/** Persist the next cursor position. */
function writeCursor(userDataDir: string, n: number): void {
  const p = cursorPath(userDataDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, String(n), 'utf8');
}

/** Bench policy (spec §B4): 3 consecutive failures bench a handler for the next
 * 3 full rotations. The bench expires on its own; the streak query only counts
 * rows newer than the bench timestamp, so an expired bench can't instantly
 * re-trigger on the same three old failures. */
const BENCH_AFTER_FAILURES = 3;
const BENCH_ROTATIONS = 3;

interface AdaptiveState {
  rotation: number;
  /** handler → bench: skipped while rotation < until; `at` is the streak watermark. */
  benches: Record<string, { until: number; at: string }>;
  /** handler → lifetime count of pre-check skips (surfaced by metrics --agents). */
  skips: Record<string, number>;
}

function adaptivePath(userDataDir: string): string {
  return join(userDataDir, 'state', 'runtime', 'agent-runner-adaptive.json');
}

function readAdaptive(userDataDir: string): AdaptiveState {
  try {
    const raw = JSON.parse(
      readFileSync(adaptivePath(userDataDir), 'utf8'),
    ) as Partial<AdaptiveState>;
    return {
      rotation: typeof raw.rotation === 'number' ? raw.rotation : 0,
      benches: raw.benches && typeof raw.benches === 'object' ? raw.benches : {},
      skips: raw.skips && typeof raw.skips === 'object' ? raw.skips : {},
    };
  } catch {
    return { rotation: 0, benches: {}, skips: {} };
  }
}

function writeAdaptive(userDataDir: string, s: AdaptiveState): void {
  const p = adaptivePath(userDataDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(s), 'utf8');
}

/** Last-N consecutive-failure check for a handler, ignoring rows at/before the
 * given watermark (the handler's last bench). Failure = error/timeout status or
 * a did-work claim its verifier rejected. */
function hasFailureStreak(db: RobinDb, handler: string, sinceTs: string | undefined): boolean {
  const rows = db
    .prepare(
      `SELECT status, verified FROM agent_usage
        WHERE surface='agentic-autonomous' AND label=? AND (? IS NULL OR ts > ?)
        ORDER BY ts DESC LIMIT ?`,
    )
    .all(handler, sinceTs ?? null, sinceTs ?? null, BENCH_AFTER_FAILURES) as Array<{
    status: string | null;
    verified: string | null;
  }>;
  if (rows.length < BENCH_AFTER_FAILURES) return false;
  return rows.every(
    (r) => r.status === 'error' || r.status === 'timeout' || r.verified === 'outcome-mismatch',
  );
}

/**
 * Tick: pick the next autonomous handler (round-robin), take the single-flight
 * lock, and spawn a DETACHED child that runs the handler to completion outside
 * this 120s tick. Returns immediately — the tick never waits on the child.
 *
 *  - lock held by a fresh run → `{status:'skipped'}` (no spawn, cursor untouched)
 *  - lock acquired → spawn detached + unref, advance cursor, `{status:'ok'}`
 */
export async function runAgentRunner(
  ctx: JobContext,
  deps: AgentRunnerDeps = {},
): Promise<JobResult> {
  const userDataDir = deps.userDataDir ?? resolveUserDataDir();

  // Master kill-switch: agentic runs make real, paid SDK calls, so the feature is
  // OFF unless explicitly enabled. A disabled tick is a clean no-op (never spawns).
  const isEnabled = deps.isEnabled ?? (() => loadPolicies(userDataDir).agent.enabled);
  if (!isEnabled()) {
    return { status: 'skipped', message: 'agent.enabled is false' };
  }

  const spawnFn = deps.spawn ?? spawn;
  const runnerEntry = (deps.runnerEntryPath ?? defaultRunnerEntryPath)();

  const lock = lockPath(userDataDir);
  if (!acquire(lock, { staleMs: LOCK_STALE_MS, now: () => ctx.now().getTime() })) {
    // A prior detached run is still in flight (or a manual one) — back off this tick.
    ctx.log.info({ lock }, 'agent-runner: lock held, skipping tick');
    return { status: 'skipped', message: 'autonomous runner already in flight' };
  }

  // Adaptive dispatch (spec §B4): round-robin is the base order; pre-checks and
  // 3-strikes benching modulate it. Cursor + adaptive state read after the lock
  // so a skipped tick never burns a handler slot.
  const adaptive = readAdaptive(userDataDir);
  const knowledgeDir = join(userDataDir, 'content', 'knowledge');
  const cursor = readCursor(userDataDir);
  let picked: string | undefined;
  let steps = 0;

  for (let i = 0; i < AUTONOMOUS_HANDLERS.length && !picked; i++) {
    const h = AUTONOMOUS_HANDLERS[(cursor + i) % AUTONOMOUS_HANDLERS.length] as string;
    steps = i + 1;
    const bench = adaptive.benches[h];

    if (bench && adaptive.rotation < bench.until) {
      ctx.log.info({ handler: h, until: bench.until }, 'agent-runner: benched, skipping');
      continue;
    }
    // 3-strikes: bench instead of dispatching (counts only runs after the last
    // bench's watermark, so an expired bench can't re-trigger on its own rows).
    if (hasFailureStreak(ctx.db, h, bench?.at)) {
      adaptive.benches[h] = {
        until: adaptive.rotation + BENCH_ROTATIONS,
        at: ctx.now().toISOString(),
      };
      try {
        recordAlert(ctx.db, {
          severity: 'warning',
          source: 'agent-runner',
          key: `handler-benched:${h}`,
          message: `handler ${h} failed ${BENCH_AFTER_FAILURES} consecutive runs — benched for ${BENCH_ROTATIONS} rotations`,
        });
      } catch {
        /* best-effort: alerting never throws into the job */
      }
      ctx.log.warn({ handler: h }, 'agent-runner: benched after failure streak');
      continue;
    }
    // Expired bench with no fresh streak: the handler has served its time — drop
    // the stale entry and resolve its alert so the next run is treated normally.
    if (bench) {
      delete adaptive.benches[h];
      try {
        resolveAlert(ctx.db, 'agent-runner', `handler-benched:${h}`);
      } catch {
        /* best-effort: alerting never throws into the job */
      }
    }
    const pc = preCheck(h, { db: ctx.db, knowledgeDir, now: ctx.now });
    if (!pc.run) {
      adaptive.skips[h] = (adaptive.skips[h] ?? 0) + 1;
      ctx.log.info({ handler: h, reason: pc.reason }, 'agent-runner: pre-check skip');
      continue;
    }
    picked = h;
  }

  // Advance cursor past everything examined; count completed rotations.
  adaptive.rotation += Math.floor((cursor + steps) / AUTONOMOUS_HANDLERS.length);
  writeCursor(userDataDir, (cursor + steps) % AUTONOMOUS_HANDLERS.length);
  writeAdaptive(userDataDir, adaptive);

  if (!picked) {
    release(lock);
    return { status: 'skipped', message: 'all handlers benched or pre-check-skipped' };
  }
  const handler = picked;

  // Detached child: outlives this process, no stdio inheritance, fully unref'd so
  // the daemon's tick loop is never blocked waiting on the agent run.
  const args = ['exec', 'tsx', runnerEntry, `--handler=${handler}`];
  let child: ChildProcess;
  try {
    child = spawnFn('pnpm', args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (err) {
    // If the spawn itself fails, release the lock so the next tick can retry
    // instead of waiting for the stale-ms window to expire.
    release(lock);
    ctx.log.error({ err, handler }, 'agent-runner: failed to spawn detached runner');
    return { status: 'error', message: `failed to spawn runner for handler ${handler}` };
  }

  ctx.log.info({ handler, pid: child.pid, runnerEntry }, 'agent-runner: spawned detached runner');
  return { status: 'ok', message: `dispatched autonomous handler ${handler}` };
}

export const job: Job = {
  run: (ctx) => runAgentRunner(ctx),
};

// Re-exported for tests + operators that want to introspect the rotation.
export { AUTONOMOUS_HANDLERS, LOCK_STALE_MS };

/** True when the lockfile currently exists (for tests/diagnostics). */
export function lockExists(userDataDir: string): boolean {
  return existsSync(lockPath(userDataDir));
}
