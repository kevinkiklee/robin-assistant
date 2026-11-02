// Detached cognition child (spec A). Self-sufficient by design: the daemon may
// die mid-run, so lease renewal, completion, cron re-arm, deadline, and SIGTERM
// cleanup all live HERE. The daemon's supervision (fast-fail watch, backstop
// kill) is advisory.
import { join } from 'node:path';
import { release } from '../../agent/single-flight.ts';
import { UsageLedger } from '../../agent/usage-ledger.ts';
import { loadModels, loadPolicies } from '../../kernel/config/load.ts';
import { rescheduleCronAfterCompletion } from '../../kernel/scheduler/cron.ts';
import { createLogger } from '../../lib/logging/logger.ts';
import { dbFilePath, resolveUserDataDir } from '../../lib/paths.ts';
import { loadEnvFile } from '../../lib/secrets/load-env.ts';
import { buildDispatcherFromConfig } from '../llm/build-dispatcher.ts';
import type { LLMDispatcher } from '../llm/dispatcher.ts';
import { closeDb, openDb, type RobinDb } from '../memory/db.ts';
import { allMigrations } from '../memory/migrations/index.ts';
import { runBiographer } from './biographer.ts';
import { runDream } from './dream.ts';
import { runEntityHygiene } from './entity-hygiene.ts';

const LEASE_MS = 5 * 60_000; // short: a dead child is reclaimable within minutes
const RENEW_EVERY_MS = 60_000;

export interface CognitionJobSpec {
  deadlineMs: number;
  run: (
    db: RobinDb,
    llm: LLMDispatcher | null,
    policies: ReturnType<typeof loadPolicies>,
  ) => Promise<void>;
}

// NOTE: `policies.biographer.draftClaims` / `.domainGating` — NOT
// `policies.cognition.*` (that block doesn't exist). Confirmed against
// daemon.ts's registerCognitionJobs(...) call site, which feeds the getters
// `() => loadPolicies(userData).biographer.draftClaims` and
// `() => loadPolicies(userData).biographer.domainGating` — same source the
// in-process cron handlers in jobs.ts use. Same paths here, no drift.
export const COGNITION_CHILD_JOBS: Record<string, CognitionJobSpec> = {
  'biographer.run': {
    // STEADY-STATE mode (2026-06-10), not backlog-drain. Earlier "max throughput"
    // settings (30 chunks/tick, 15-min deadline) assumed the backlog would clear
    // and the config would be reverted — but inflow is continuous (~1.5-4k
    // captured sessions/day from always-on Claude Code loops), so there is no
    // "after the backlog". Those 8-16-min ticks blocked the sequential scheduler
    // loop, tripped the 7-min heartbeat CRITICAL hundreds of times/day, and
    // outran the job lease on every single run (231/232 runs reaped mid-flight).
    //
    // Short ticks on the every-minute cron deliver the SAME chunks/hour — the
    // cron re-arms on completion, so throughput is cadence × budget, not tick
    // length (10 chunks/~3-min cycle ≈ the old 30 chunks/~13-min cycle). What
    // changes: the loop yields every few minutes (other jobs wait ≤~4 min, not
    // ≤16), normal ticks stay under the 7-min heartbeat ceiling, and heartbeat
    // CRITICAL once again means something is actually wrong.
    //
    // deadlineMs here is the CHILD's hard wall-clock cap (process-isolated —
    // spec A), separate from tickDeadlineMs below (the in-run budget passed to
    // runBiographer). 15 min is 2× the degraded-provider worst case, not a
    // license for long ticks.
    deadlineMs: 15 * 60_000,
    run: async (db, llm, policies) => {
      await runBiographer(db, llm, 30, {
        maxChunksPerTick: 10,
        batchChunks: 5,
        skipToolChunks: true,
        draftClaims: policies.biographer.draftClaims,
        domainGating: policies.biographer.domainGating,
        tickDeadlineMs: 3 * 60 * 1000,
      });
    },
  },
  'dream.run': {
    deadlineMs: 45 * 60_000,
    run: async (db, llm, policies) => {
      await runDream(db, llm, undefined, { domainGating: policies.biographer.domainGating });
    },
  },
  'entity-hygiene.run': {
    // Weekly, bounded (≤12 groups / 2 classify calls / ≤10 merges per run).
    deadlineMs: 15 * 60_000,
    run: async (db, llm) => {
      await runEntityHygiene(db, llm, { apply: true });
    },
  },
};

export function parseChildArgs(argv: string[]): { job: string; jobId: number } | null {
  const flag = (p: string) => argv.find((a) => a.startsWith(p))?.slice(p.length);
  const job = flag('--job=') ?? '';
  const jobId = Number.parseInt(flag('--job-id=') ?? '', 10);
  if (!COGNITION_CHILD_JOBS[job] || !Number.isFinite(jobId) || jobId <= 0) return null;
  return { job, jobId };
}

/** Stamp the row as child-owned. Refuses when the row isn't leased or names a
 *  different job — a stale id must never let us run against the wrong row. */
export function takeOverLease(db: RobinDb, jobId: number, job: string, pid: number): boolean {
  const until = new Date(Date.now() + LEASE_MS).toISOString();
  return (
    db
      .prepare(
        `UPDATE jobs SET claimed_by=?, leased_until=?
          WHERE id=? AND name=? AND state='leased'`,
      )
      .run(`child:${pid}`, until, jobId, job).changes > 0
  );
}

export function renewChildLease(db: RobinDb, jobId: number, pid: number): boolean {
  const until = new Date(Date.now() + LEASE_MS).toISOString();
  return (
    db
      .prepare(`UPDATE jobs SET leased_until=? WHERE id=? AND claimed_by=? AND state='leased'`)
      .run(until, jobId, `child:${pid}`).changes > 0
  );
}

/**
 * Write completed/errored + re-arm the cron — ONLY while we still own the row.
 * Returns false when ownership was lost (lease reaped + reclaimed): a zombie
 * child must never stomp a row someone else now owns.
 *
 * The ownership check and the terminal-state write are ONE atomic UPDATE
 * (`WHERE id=? AND claimed_by=?`) — same idiom as `renewChildLease`. A
 * SELECT-then-UPDATE here would TOCTOU across processes: `recoverExpiredLeases`
 * can re-pend (and something else re-claim) the row between the two
 * statements — realistic on wake-from-sleep — and a plain `WHERE id=?` UPDATE
 * would then stomp the re-pended/re-claimed row regardless of who owns it by
 * write time. `.changes` from the guarded UPDATE is the sole source of truth;
 * the follow-up SELECT (for the cron-reschedule payload) only runs after a
 * confirmed win and reads a row we just terminally wrote ourselves, so it
 * can't itself race.
 */
export function writeChildCompletion(
  db: RobinDb,
  jobId: number,
  pid: number,
  outcome: 'ok' | 'error',
  error?: string,
): boolean {
  const claimedBy = `child:${pid}`;
  const changes =
    outcome === 'error'
      ? db
          .prepare(
            `UPDATE jobs SET state='errored', last_error=?, leased_until=NULL, claimed_by=NULL
              WHERE id=? AND claimed_by=?`,
          )
          .run(error ?? 'error', jobId, claimedBy).changes
      : db
          .prepare(
            `UPDATE jobs SET state='completed', leased_until=NULL, claimed_by=NULL
              WHERE id=? AND claimed_by=?`,
          )
          .run(jobId, claimedBy).changes;
  if (changes === 0) return false;
  const row = db.prepare(`SELECT name, trigger_kind, payload FROM jobs WHERE id=?`).get(jobId) as
    | { name: string; trigger_kind: string; payload: string | null }
    | undefined;
  if (row) rescheduleCronAfterCompletion(db, row);
  return true;
}

/**
 * Decide whether `finish()` (inside `runCognitionChild`) should release the
 * single-flight lock after a completion-write attempt. Extracted as a pure,
 * exported decision so it's unit-testable on its own: `finish()` lives inside
 * `runCognitionChild`'s closure, which isn't independently testable without
 * either spawning a real child (Task 6's job) or a deps-injection seam this
 * file doesn't have yet.
 *
 * Only release when the write actually landed (we still owned the row through
 * the guarded UPDATE above). `release()` is pid-blind — if ownership was
 * already lost (lease reaped + stale-steal), releasing here would delete
 * whatever NEW run's lock now sits at that path, reopening the
 * mutual-exclusion hole the lock exists to close.
 */
export function shouldReleaseLockOnFinish(wrote: boolean): boolean {
  return wrote;
}

/**
 * One lease-renewal "beat" — extracted from the `setInterval` callback so it's
 * directly unit-testable without a real timer. Returns `true` when the child
 * should keep running, `false` when it must exit.
 *
 * A THROWN renew (e.g. SQLITE_BUSY under WAL contention) is caught and logged
 * as a warning, then treated as "keep going" — the row's `leased_until` simply
 * didn't get extended this beat, and the next beat (60s later) tries again. It
 * is NOT ownership loss: throwing means the UPDATE never ran, so we don't know
 * whether we still hold the lease, and killing the child on a transient DB
 * hiccup would abandon a run that's making fine progress. Only an explicit
 * `renew(...) === false` (the guarded UPDATE ran and matched zero rows — the
 * lease was reaped and reclaimed) is real ownership loss, and that alone
 * signals exit, exactly as before this beat was made resilient.
 */
export function renewalBeat(
  db: RobinDb,
  jobId: number,
  pid: number,
  log: ReturnType<typeof createLogger>,
  renew: (db: RobinDb, jobId: number, pid: number) => boolean = renewChildLease,
): boolean {
  try {
    if (renew(db, jobId, pid)) return true;
    log.error('child: lease lost mid-run — exiting without touching the row or the lock');
    return false;
  } catch (err) {
    log.warn({ err }, 'child: renewal threw (transient DB error?) — skipping this beat');
    return true;
  }
}

/**
 * Core of the detached cognition child — testable, `process`-free apart from
 * `process.pid` and `process.exit()` calls needed to actually terminate the
 * detached process (a lingering timer or SIGTERM listener would otherwise keep
 * it alive). Exit codes: 0 completed, 1 errored-but-recorded, 2 could not even
 * record (bad args, row mismatch, schema behind, DB unreachable).
 */
export async function runCognitionChild(args: { job: string; jobId: number }): Promise<number> {
  const userData = resolveUserDataDir();
  // Own log file, shared by every cognition child (module field distinguishes
  // which job produced a given line) — the daemon's own log rotation/tailing
  // habits don't apply here since this process is detached and outlives the
  // daemon's stdout capture.
  //
  // sync: true is required here, not just a nice-to-have: this is a short-
  // lived process whose diagnostic lines (openDb failed, schema behind,
  // takeover refused, SIGTERM, deadline exceeded, lease lost) are almost
  // always immediately followed by process.exit() in the same tick. An async
  // destination's first write can be silently dropped if the process exits
  // before pino's SonicBoom worker thread finishes opening the file — this
  // process logs low-volume enough (a handful of lines per run) that the
  // blocking-write cost is irrelevant next to actually keeping the lines.
  const log = createLogger({
    module: `cognition-child:${args.job}`,
    file: join(userData, 'observability', 'logs', 'cognition-children.log'),
    sync: true,
  });
  loadEnvFile(userData);

  const lockPath = join(userData, 'state', 'runtime', `cognition-${args.job}.lock`);

  let db: RobinDb;
  try {
    db = openDb(dbFilePath(userData));
  } catch (err) {
    log.error({ err }, 'child: openDb failed');
    // We are the sole current holder of this lock (just spawned, no renewal
    // loop has started) — a transient DB hiccup must not block the next cron
    // run for a full stale-steal window.
    release(lockPath);
    return 2;
  }

  // Schema assert — the child NEVER migrates (the daemon owns that). Robin's
  // migration runner (system/brain/memory/migrations/runner.ts) tracks applied
  // versions in a `_migrations` ledger table, NOT `PRAGMA user_version` (that
  // pragma is never written anywhere in this codebase). Mirrors the
  // `db.schema_current` invariant (system/kernel/invariants/builtins/
  // db-schema-current.ts) so the two checks can never silently disagree.
  try {
    const expected = allMigrations[allMigrations.length - 1]?.version ?? 0;
    const row = db.prepare('SELECT MAX(version) as v FROM _migrations').get() as {
      v: number | null;
    };
    const current = row.v ?? 0;
    if (current < expected) {
      log.error({ current, expected }, 'child: schema behind — daemon must migrate, not the child');
      closeDb(db);
      release(lockPath);
      return 2;
    }
  } catch (err) {
    log.error({ err }, 'child: schema version check failed');
    closeDb(db);
    release(lockPath);
    return 2;
  }

  if (!takeOverLease(db, args.jobId, args.job, process.pid)) {
    log.error({ jobId: args.jobId }, 'child: lease takeover refused (row reaped or wrong job)');
    closeDb(db);
    release(lockPath);
    return 2;
  }
  log.info({ job: args.job, jobId: args.jobId }, 'child: run started');

  let finished = false;
  // Declared before `finish` (assigned just after) so `finish` — invoked from
  // the deadline timer, SIGTERM handler, and the normal completion path below,
  // all of which run AFTER both are assigned — can clear them via closure.
  let renewTimer: NodeJS.Timeout | undefined;
  let deadlineTimer: NodeJS.Timeout | undefined;
  const finish = (outcome: 'ok' | 'error', error?: string): void => {
    if (finished) return;
    finished = true;
    log.info({ job: args.job, jobId: args.jobId, outcome }, 'child: run finished');
    // Clear both timers on every exit from finish(): without this, a still-
    // pending renewTimer fires on the now-CLOSED db below (a throw the
    // renewalBeat try/catch now swallows harmlessly, but it's still dead work
    // on a handle we're trying to retire), and a still-pending, no-longer-
    // unref'd deadlineTimer would otherwise sit around after a normal finish.
    if (renewTimer) clearInterval(renewTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    let wrote = false;
    try {
      wrote = writeChildCompletion(db, args.jobId, process.pid, outcome, error);
      if (!wrote) log.warn('child: ownership lost — completion not written');
    } catch (err) {
      log.error({ err }, 'child: completion write failed');
    }
    // Skip release when the write didn't land: after a lease-reap + stale-steal
    // this same lock path may already belong to a NEW run — release() is
    // pid-blind, so releasing here would delete that run's lock out from under
    // it. Consistent with the renewal-failure path below, which never releases.
    if (shouldReleaseLockOnFinish(wrote)) release(lockPath);
    try {
      closeDb(db);
    } catch {
      /* exiting anyway */
    }
  };

  renewTimer = setInterval(() => {
    if (!renewalBeat(db, args.jobId, process.pid, log)) {
      // Ownership lost (lease expired, reclaimed, possibly re-leased to someone
      // else already). Zombie guard: do NOT write completion (it isn't ours to
      // write) and do NOT release the lock (a new owner may already hold it) —
      // just stop. A genuinely orphaned lock still expires on its own staleMs.
      finished = true; // suppress finish(): the row is someone else's now
      process.exit(1);
    }
  }, RENEW_EVERY_MS);
  renewTimer.unref();

  const spec = COGNITION_CHILD_JOBS[args.job] as CognitionJobSpec;
  deadlineTimer = setTimeout(() => {
    log.error({ deadlineMs: spec.deadlineMs }, 'child: deadline exceeded — recording + exiting');
    finish('error', `deadline ${spec.deadlineMs}ms exceeded`);
    process.exit(1);
  }, spec.deadlineMs);
  // Deliberately NOT unref'd: this is the true backstop. renewTimer is unref'd
  // (it must never keep the process alive on its own), and SIGTERM is only
  // delivered externally — so if spec.run() hangs on something that holds no
  // timer/socket of its own (a stuck in-memory await, not an fs/network op),
  // NOTHING else would keep the event loop alive, and Node would silently
  // exit(0) mid-run without ever recording an outcome. A ref'd deadlineTimer
  // guarantees the process stays alive until the deadline fires and force-
  // completes the run with a recorded error.

  process.on('SIGTERM', () => {
    log.error('child: SIGTERM received — recording + exiting');
    finish('error', 'sigterm');
    process.exit(1);
  });

  // Mirrors the MCP extension server's separate-process dispatcher bootstrap
  // (buildExtensionDeps in system/surfaces/mcp/extension/server.ts) — lenient:
  // a missing provider degrades the run, it must not crash the child before it
  // can record state.
  let llm: LLMDispatcher | null = null;
  try {
    const models = loadModels(userData);
    llm = buildDispatcherFromConfig(models, {
      lenient: true,
      onWarn: (m) => log.warn(m),
      ledger: new UsageLedger(db),
    });
  } catch (err) {
    log.warn({ err }, 'child: dispatcher unavailable — running without LLM');
  }

  try {
    const policies = loadPolicies(userData);
    await spec.run(db, llm, policies);
    finish('ok');
    return 0;
  } catch (err) {
    finish('error', err instanceof Error ? err.message : String(err));
    return 1;
  }
}

// Entrypoint: argv → runCognitionChild → exit code. Guarded exactly the way
// system/agent/runner-entry.ts guards its own main block (that file has no
// unhandledRejection/uncaughtException handlers either — its only belt-and-
// braces is the top-level promise `.catch()` below, mirrored here).
if (import.meta.url === `file://${process.argv[1]}`) {
  const parsed = parseChildArgs(process.argv.slice(2));
  if (!parsed) {
    process.stderr.write(
      `cognition-runner-entry: usage: --job=<${Object.keys(COGNITION_CHILD_JOBS).join('|')}> --job-id=<n>\n`,
    );
    process.exit(2);
  }
  void runCognitionChild(parsed)
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      // Belt-and-braces: runCognitionChild catches its own failures, so this
      // only fires on a bug in the entrypoint itself — still exit nonzero.
      process.stderr.write(
        `cognition-runner-entry: fatal: ${err instanceof Error ? err.stack : err}\n`,
      );
      process.exit(1);
    });
}
