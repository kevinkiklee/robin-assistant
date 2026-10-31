// Daemon-side spawn dispatch for the two cognition child jobs (biographer.run,
// dream.run — spec A: failure containment via process isolation). Mirrors
// system/jobs/builtin/agent-runner/index.ts's detached-spawn shape (single-flight
// lock, spawn+unref, injectable deps for tests) but targets the self-sufficient
// child entrypoint from Task 2 (cognition-runner-entry.ts) instead of the agent
// runner-entry, and adds a short fast-fail watch the child can't provide for
// itself (it has no supervisor over its own spawn).
import { type ChildProcess, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquire, release } from '../../agent/single-flight.ts';
import { recordAlert, resolveAlert } from '../../kernel/runtime/alert-store.ts';
import { completeJob, type JobRow } from '../../kernel/scheduler/claim.ts';
import { rescheduleCronAfterCompletion } from '../../kernel/scheduler/cron.ts';
import { createLogger } from '../../lib/logging/logger.ts';
import { resolveUserDataDir } from '../../lib/paths.ts';
import type { RobinDb } from '../memory/db.ts';
import { COGNITION_CHILD_JOBS } from './cognition-runner-entry.ts';

// Runs inside the daemon process (no `file` option): launchd's StandardOutPath
// already redirects the daemon's own stdout to observability/logs/daemon.log
// (see lib/launchd/install.ts), so a plain stdout logger lands there for free.
const log = createLogger({ module: 'cognition-detached' });

/** Signature of the injectable spawner — a thin subset of child_process.spawn. */
export type SpawnFn = typeof spawn;

export interface DetachedSpawnDeps {
  /** Injected so tests use a fake instead of spawning a real child. */
  spawn?: SpawnFn;
  /** Absolute user-data dir; resolved from the environment when omitted. */
  userDataDir?: string;
  /** Resolves the cognition-runner-entry script path; overridable in tests. */
  entryPath?: () => string;
  /** Injected for tests; defaults to wall-clock ms. */
  now?: () => number;
  /** Overrides the fast-fail / spawn-success window (default 15s). Injected so
   *  tests don't have to wait out the real window to see the success timer fire. */
  fastFailWindowMs?: number;
}

/** Mirrors the child's own IS_COMPILED idiom: prefer compiled .js, else .ts under tsx. */
const IS_COMPILED = import.meta.url.endsWith('.js');

/** A nonzero exit inside this window (from spawn time) is treated as a spawn-time
 *  failure (e.g. the pnpm-pruned-better-sqlite3 binding case) rather than a normal
 *  run outcome the child itself would have recorded. */
const FAST_FAIL_WINDOW_MS = 15_000;

/**
 * Resolve the cognition-runner-entry script next to THIS module — both live in
 * system/brain/cognition/, so no directory traversal is needed (unlike
 * agent-runner, whose entry lives three levels up). Compiled runs spawn the
 * .js; tsx dev runs spawn the .ts.
 */
function defaultEntryPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const ext = IS_COMPILED ? 'js' : 'ts';
  return join(here, `cognition-runner-entry.${ext}`);
}

/** Path to the single-flight lockfile. MUST byte-match the child's own derivation
 *  in cognition-runner-entry.ts's runCognitionChild (`cognition-<job>.lock` under
 *  `<userData>/state/runtime/`) — the daemon takes this lock before spawning, the
 *  child releases it on completion; a mismatched path would defeat single-flight
 *  entirely. */
function lockPath(userDataDir: string, jobName: string): string {
  return join(userDataDir, 'state', 'runtime', `cognition-${jobName}.lock`);
}

/**
 * Take the single-flight lock and spawn a detached cognition child for `job`
 * (biographer.run or dream.run). Returns `'skipped'` when a fresh run is
 * already in flight (lock held, not stale) — the caller then completes the
 * tick as a normal no-op, same as any other skipped handler. Returns
 * `'detached'` once the child is spawned and unref'd — the caller must NOT
 * complete the job row; the child owns it from here (lease renewal,
 * completion, cron re-arm all happen in runCognitionChild).
 *
 * Also installs an advisory fast-fail watch: if the child dies within 15s of
 * spawn while the row is still `leased`, this makes the known
 * pnpm-pruned-better-sqlite3 failure mode visible instead of silently wedging
 * the row until lease expiry (spec A: failure containment). The watch is a
 * pure bonus — if the daemon itself dies first, the child (if it ever
 * started) is still self-sufficient, and a truly orphaned lease still expires
 * on its own staleMs.
 *
 * A spawn that SURVIVES the fast-fail window is the mirror-image signal: it
 * closes out any `cognition`/`spawn-fail:<job.name>` alert left open by a
 * PRIOR failed spawn (backlog #5). Without this, one transient spawn failure
 * (a momentary PATH hiccup, a brief FS contention) leaves its incident open
 * forever even once the job is spawning cleanly again — nothing else ever
 * calls `resolveAlert` for this key.
 */
export function spawnCognitionChild(
  db: RobinDb,
  job: JobRow,
  deps: DetachedSpawnDeps = {},
): 'detached' | 'skipped' {
  const spec = COGNITION_CHILD_JOBS[job.name];
  if (!spec) {
    // Defensive: jobs.ts only routes COGNITION_CHILD_JOBS names here.
    throw new Error(`spawnCognitionChild: no COGNITION_CHILD_JOBS entry for '${job.name}'`);
  }

  const userDataDir = deps.userDataDir ?? resolveUserDataDir();
  const now = deps.now ?? (() => Date.now());
  const spawnFn = deps.spawn ?? spawn;
  const entryPath = (deps.entryPath ?? defaultEntryPath)();
  const fastFailWindowMs = deps.fastFailWindowMs ?? FAST_FAIL_WINDOW_MS;

  const lock = lockPath(userDataDir, job.name);
  // Stale window: the child's own deadline (its worst-case legitimate runtime)
  // plus 5 min slack — long enough that a still-running child is never stomped,
  // short enough that an abandoned lock (daemon+child both died) is reclaimed
  // within a bounded window rather than wedging the job forever.
  if (!acquire(lock, { staleMs: spec.deadlineMs + 5 * 60_000, now })) {
    return 'skipped';
  }

  const args = [`--job=${job.name}`, `--job-id=${job.id}`];
  const isCompiledEntry = entryPath.endsWith('.js');
  // node for .js / pnpm exec tsx for .ts — same command construction as
  // agent-runner's detached spawn, extended to the compiled case (agent-runner
  // itself only ever spawns via tsx; the child entry here can run compiled).
  const cmd = isCompiledEntry ? process.execPath : 'pnpm';
  const spawnArgs = isCompiledEntry ? [entryPath, ...args] : ['exec', 'tsx', entryPath, ...args];

  let child: ChildProcess;
  try {
    child = spawnFn(cmd, spawnArgs, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (err) {
    // Spawn itself failed synchronously — release the lock so the next tick can
    // retry instead of waiting out the stale window, then propagate: the
    // scheduler's try/catch marks the row errored and re-arms the cron.
    release(lock);
    throw err;
  }

  const spawnedAt = now();
  // Shared across both listeners so a fast-fail exit and an async spawn error
  // can never both run cleanup — whichever fires first wins, the other is a
  // no-op. Without this a code path that somehow fired both events would
  // double-complete the row / double-release the lock.
  let handled = false;
  const failSpawn = (error: string, alertMessage: string): void => {
    if (handled) return;
    handled = true;
    // Guarded: only act while the row is still ours to declare dead. If the
    // child (or a lease reaper) already moved the row on, this watch is a
    // no-op — advisory only, never a second writer racing the real owner.
    const row = db.prepare('SELECT state FROM jobs WHERE id=?').get(job.id) as
      | { state: string }
      | undefined;
    if (!row || row.state !== 'leased') return;
    completeJob(db, job.id, 'error', error);
    // Without this, a fast-fail permanently silences the cron: completeJob
    // alone leaves ZERO pending rows for the job name, so it never runs again
    // until a daemon restart re-seeds it. The scheduler's own tickOnce always
    // re-arms after completing a row (success or error) — this watch must do
    // the same since it, not the scheduler, is completing the row here.
    rescheduleCronAfterCompletion(db, job);
    try {
      recordAlert(db, {
        severity: 'warning',
        source: 'cognition',
        key: `spawn-fail:${job.name}`,
        message: alertMessage,
      });
    } catch {
      /* alerting must never break the watch */
    }
    release(lock);
  };

  child.once('exit', (code) => {
    if (code === 0) return;
    if (now() - spawnedAt >= fastFailWindowMs) return;
    log.warn(
      { job: job.name, jobId: job.id, childPid: child.pid, code },
      'cognition child fast-failed at spawn',
    );
    failSpawn(
      `child died at spawn (exit ${code})`,
      `${job.name} child exited ${code} within ${fastFailWindowMs}ms of spawn`,
    );
  });

  // Async spawn failures (e.g. ENOENT — 'pnpm' unresolvable under launchd's
  // trimmed PATH) surface as an 'error' event, NOT 'exit' — an unhandled
  // EventEmitter 'error' throws, which would crash the whole daemon on the
  // very first bad PATH. Contained the same way as a fast-fail exit: complete
  // the row, re-arm the cron, alert, release the lock.
  child.once('error', (err) => {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      { job: job.name, jobId: job.id, childPid: child.pid, err: message },
      'cognition child spawn error',
    );
    failSpawn(`child spawn error: ${message}`, `${job.name} child spawn error: ${message}`);
  });

  // Arm alongside the fast-fail watch above, same window: once a spawn
  // survives it without dying, `handled` is still false and any stale
  // spawn-fail incident for this job is closed. unref'd — this timer is a
  // bonus cleanup, never a reason to keep the daemon process alive.
  const successTimer = setTimeout(() => {
    if (handled) return; // fast-failed or errored within the window — already handled
    try {
      resolveAlert(db, 'cognition', `spawn-fail:${job.name}`);
    } catch (err) {
      log.warn({ err, job: job.name }, 'failed to resolve spawn-fail alert after healthy spawn');
    }
  }, fastFailWindowMs);
  successTimer.unref();

  log.info(
    { job: job.name, jobId: job.id, childPid: child.pid },
    'spawned detached cognition child',
  );

  return 'detached';
}
