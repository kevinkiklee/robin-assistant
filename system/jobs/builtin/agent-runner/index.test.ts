import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquire } from '../../../agent/single-flight.ts';
import { closeDb, openDb, type RobinDb } from '../../../brain/memory/db.ts';
import { allMigrations, applyMigrations } from '../../../brain/memory/migrations/index.ts';
import { listAlerts } from '../../../kernel/runtime/alert-store.ts';
import type { JobContext } from '../../_runtime/types.ts';
import {
  type AgentRunnerDeps,
  AUTONOMOUS_HANDLERS,
  lockExists,
  runAgentRunner,
  type SpawnFn,
} from './index.ts';

/**
 * A throwaway user-data dir; state/runtime is created lazily by the job. The
 * knowledge dir is created empty so handler D's pre-check finds no stale files
 * (and thus deterministically skips on an otherwise-empty instance).
 */
function tmpUserData(): string {
  const ud = mkdtempSync(join(tmpdir(), 'robin-agent-runner-'));
  mkdirSync(join(ud, 'content', 'knowledge'), { recursive: true });
  return ud;
}

/** A fresh in-memory-ish RobinDb with all migrations applied. */
function freshDb(): RobinDb {
  const dir = mkdtempSync(join(tmpdir(), 'robin-agent-runner-db-'));
  const db = openDb(join(dir, 'robin.sqlite'));
  applyMigrations(db, allMigrations);
  return db;
}

/**
 * Minimal JobContext carrying a real `db` (benching reads agent_usage + writes
 * alerts), plus `now` and `log`. The caller owns the db's lifecycle.
 */
function fakeCtx(db: RobinDb, now: () => Date = () => new Date(0)): JobContext {
  const noop = () => {};
  return {
    db,
    now,
    log: { info: noop, warn: noop, error: noop },
  } as unknown as JobContext;
}

/** A fake child that records nothing but satisfies `.pid` + `.unref()`. */
function fakeChild(): ChildProcess {
  return { pid: 12345, unref: () => {} } as unknown as ChildProcess;
}

interface SpawnCall {
  cmd: string;
  args: readonly string[];
  opts: unknown;
}

/** A spawn spy that records each call and returns an unref-able fake child. */
function spySpawn() {
  const calls: SpawnCall[] = [];
  // Cast through `unknown` — child_process.spawn has broad overloads we don't model.
  const fn = ((cmd: string, args: readonly string[], opts: unknown): ChildProcess => {
    calls.push({ cmd, args, opts });
    return fakeChild();
  }) as unknown as SpawnFn;
  return { calls, fn };
}

const RUNNER_ENTRY = '/fake/system/agent/runner-entry.ts';

/** Deps with the kill-switch forced ON (the default reads policies from disk). */
function enabledDeps(ud: string, spawn: SpawnFn): AgentRunnerDeps {
  return { userDataDir: ud, spawn, runnerEntryPath: () => RUNNER_ENTRY, isEnabled: () => true };
}

// ---------------------------------------------------------------------------
// Adaptive-state helpers (tests read the JSON the job writes, by path).
// ---------------------------------------------------------------------------

const adaptivePath = (ud: string) => join(ud, 'state', 'runtime', 'agent-runner-adaptive.json');

interface AdaptiveState {
  rotation: number;
  benches: Record<string, { until: number; at: string }>;
  skips: Record<string, number>;
}

function readAdaptiveFile(ud: string): AdaptiveState {
  return JSON.parse(readFileSync(adaptivePath(ud), 'utf8')) as AdaptiveState;
}

function writeAdaptiveFile(ud: string, s: Partial<AdaptiveState>): void {
  const p = adaptivePath(ud);
  mkdirSync(join(ud, 'state', 'runtime'), { recursive: true });
  writeFileSync(p, JSON.stringify(s), 'utf8');
}

function writeCursorFile(ud: string, n: number): void {
  const p = join(ud, 'state', 'runtime', 'agent-runner-cursor');
  mkdirSync(join(ud, 'state', 'runtime'), { recursive: true });
  writeFileSync(p, String(n), 'utf8');
}

function readCursorFile(ud: string): number {
  return Number.parseInt(
    readFileSync(join(ud, 'state', 'runtime', 'agent-runner-cursor'), 'utf8').trim(),
    10,
  );
}

/** Seed N autonomous-ledger rows for a handler with the given status/verified. */
function seedUsage(
  db: RobinDb,
  handler: string,
  rows: Array<{ status?: string; verified?: string; ts: string }>,
): void {
  const ins = db.prepare(
    `INSERT INTO agent_usage (ts, surface, label, status, verified) VALUES (?, 'agentic-autonomous', ?, ?, ?)`,
  );
  for (const r of rows) ins.run(r.ts, handler, r.status ?? null, r.verified ?? null);
}

/** The round-robin index of a handler id. */
const idxOf = (h: string) => (AUTONOMOUS_HANDLERS as readonly string[]).indexOf(h);

/** Extract the `--handler=X` id from a recorded spawn call. */
function dispatchedId(call: SpawnCall | undefined): string {
  const flag = call?.args[3] ?? '';
  return flag.split('=')[1] ?? '';
}

// ===========================================================================
// Existing behavior — kill-switch, lock, spawn shape, failure handling
// ===========================================================================

test('agent-runner: skipped (no spawn) when agent.enabled is false', async () => {
  const ud = tmpUserData();
  const db = freshDb();
  const { calls, fn } = spySpawn();
  const r = await runAgentRunner(fakeCtx(db), {
    ...enabledDeps(ud, fn),
    isEnabled: () => false,
  });
  assert.equal(r.status, 'skipped');
  assert.equal(calls.length, 0, 'a disabled runner must never spawn');
  closeDb(db);
});

test('agent-runner: defaults to disabled when no policies/config exists', async () => {
  // No isEnabled override → reads agent.enabled from policies, which defaults OFF.
  const ud = tmpUserData();
  const db = freshDb();
  const { calls, fn } = spySpawn();
  const r = await runAgentRunner(fakeCtx(db), {
    userDataDir: ud,
    spawn: fn,
    runnerEntryPath: () => RUNNER_ENTRY,
  });
  assert.equal(r.status, 'skipped');
  assert.equal(calls.length, 0, 'agent is opt-in: a config-less instance never spawns');
  closeDb(db);
});

test('agent-runner: spawns a detached child + returns ok', async () => {
  // Cursor at B (always runs) → exactly one detached spawn this tick.
  const ud = tmpUserData();
  const db = freshDb();
  const { calls, fn } = spySpawn();
  const r = await runAgentRunner(fakeCtx(db), enabledDeps(ud, fn));
  assert.equal(r.status, 'ok');
  assert.equal(calls.length, 1, 'exactly one detached child per tick');
  // Detached + no stdio inheritance — the daemon never blocks on the child.
  assert.deepEqual(calls[0]?.opts, { detached: true, stdio: 'ignore' });
  assert.equal(dispatchedId(calls[0]), 'B');
  closeDb(db);
});

test('agent-runner: argv targets runner-entry with a handler id', async () => {
  const ud = tmpUserData();
  const db = freshDb();
  const { calls, fn } = spySpawn();
  await runAgentRunner(fakeCtx(db), enabledDeps(ud, fn));
  const call = calls[0];
  assert.ok(call, 'spawn should have been called');
  assert.equal(call.cmd, 'pnpm');
  assert.deepEqual(call.args.slice(0, 3), ['exec', 'tsx', RUNNER_ENTRY]);
  const handlerFlag = call.args[3] ?? '';
  assert.match(handlerFlag, /^--handler=[A-Z]$/);
  const id = handlerFlag.split('=')[1] ?? '';
  assert.ok(
    (AUTONOMOUS_HANDLERS as readonly string[]).includes(id),
    `dispatched id ${id} must be an autonomous handler`,
  );
  closeDb(db);
});

test('agent-runner: returns skipped (no spawn) when the lock is held', async () => {
  const ud = tmpUserData();
  const db = freshDb();
  // Pre-seed a fresh lock so the job's acquire() must fail.
  acquire(join(ud, 'state', 'runtime', 'agent-runner.lock'), {
    staleMs: 45 * 60_000,
    now: () => 0,
    pid: 999,
  });
  const { calls, fn } = spySpawn();
  const r = await runAgentRunner(
    fakeCtx(db, () => new Date(60_000)),
    enabledDeps(ud, fn),
  );
  assert.equal(r.status, 'skipped');
  assert.equal(calls.length, 0, 'a held lock must prevent any spawn');
  closeDb(db);
});

test('agent-runner: round-robin advances the handler across ticks', async () => {
  // With pre-checks active on an empty DB, only B/G/L are immediately runnable.
  // Seed the DB so EVERY handler's pre-check passes, isolating round-robin order.
  const ud = tmpUserData();
  const db = freshDb();
  seedAllRunnable(db, ud);
  const ids: string[] = [];
  // Run as many ticks as there are handlers. Time advances an hour per tick so
  // each tick's acquire() steals the prior (now-stale) lock and succeeds, while
  // staying close to BASE so the date-relative seeds keep every pre-check green.
  for (let i = 0; i < AUTONOMOUS_HANDLERS.length; i++) {
    const { calls, fn } = spySpawn();
    await runAgentRunner(
      fakeCtx(db, () => new Date(BASE.getTime() + i * 60 * 60_000)),
      enabledDeps(ud, fn),
    );
    ids.push(dispatchedId(calls[0]));
  }
  // Cursor persists, so the sequence is the full fixed rotation in order.
  assert.deepEqual(ids, [...AUTONOMOUS_HANDLERS]);
  closeDb(db);
});

test('agent-runner: spawn failure returns error and releases lock for immediate retry', async () => {
  const ud = tmpUserData();
  const db = freshDb();
  const throwingSpawn = (() => {
    throw new Error('spawn ENOENT');
  }) as unknown as SpawnFn;
  const r = await runAgentRunner(fakeCtx(db), enabledDeps(ud, throwingSpawn));
  assert.equal(r.status, 'error');
  // Lock is released on spawn failure so the next tick can retry immediately
  // instead of waiting for the stale-ms window to expire.
  assert.equal(lockExists(ud), false, 'lock should be released on spawn failure');
  closeDb(db);
});

test('agent-runner: cursor file persists the next position', async () => {
  // Cursor at B (always runs) → one step → cursor advances to 1.
  const ud = tmpUserData();
  const db = freshDb();
  const { fn } = spySpawn();
  await runAgentRunner(fakeCtx(db), enabledDeps(ud, fn));
  assert.equal(readCursorFile(ud), 1, 'after one tick the cursor advances to 1');
  closeDb(db);
});

// ===========================================================================
// Adaptive dispatch — pre-check skips (spec §B4)
// ===========================================================================

/** A realistic base "now" for adaptive-dispatch tests with date-relative seeds. */
const BASE = new Date('2026-06-11T12:00:00.000Z');

/**
 * Make every pre-check-gated handler runnable so dispatch order is the only
 * variable: seeds the DB (E/F/H/K) and drops a stale knowledge file (D). Seed
 * dates are relative to `BASE`, which the caller must use as its `now`.
 */
function seedAllRunnable(db: RobinDb, ud: string): void {
  // E: pending belief candidate
  db.prepare(
    `INSERT INTO belief_candidates (topic, claim, status) VALUES ('t', 'c', 'pending')`,
  ).run();
  // F: a prediction past deadline (relative to BASE), unresolved
  db.prepare(
    `INSERT INTO predictions (claim, confidence, deadline) VALUES ('overdue', 0.8, ?)`,
  ).run(new Date(BASE.getTime() - 86_400_000).toISOString());
  // H: an event within the last 48h of BASE
  db.prepare(
    `INSERT INTO events (ts, kind, source, status, payload) VALUES (?, 'x', 's', 'ok', '{}')`,
  ).run(new Date(BASE.getTime() - 3_600_000).toISOString());
  // K: an open alert
  db.prepare(
    `INSERT INTO alerts (severity, source, key, message, first_seen_at, last_seen_at)
     VALUES ('warning', 'seed', 'k', 'm', datetime('now'), datetime('now'))`,
  ).run();
  // D: a knowledge file older than the 14-day staleness threshold (relative to BASE).
  const stale = join(ud, 'content', 'knowledge', 'stale.md');
  writeFileSync(stale, 'old', 'utf8');
  const old = new Date(BASE.getTime() - 30 * 86_400_000);
  utimesSync(stale, old, old);
}

test('pre-check skip advances to the next handler in the same tick', async () => {
  // Cursor at F. On an empty DB, F's pre-check skips (no due predictions). The
  // loop continues to G (always runs) and dispatches it. Cursor ends past G,
  // and the adaptive file records skips.F === 1.
  const ud = tmpUserData();
  const db = freshDb();
  const cursorF = idxOf('F');
  writeCursorFile(ud, cursorF);
  const { calls, fn } = spySpawn();
  const r = await runAgentRunner(fakeCtx(db), enabledDeps(ud, fn));

  assert.equal(r.status, 'ok');
  assert.equal(dispatchedId(calls[0]), 'G', 'F skipped → G dispatched in the same tick');
  // F and G examined → steps 2 → cursor = (F + 2) % 8 = index after G.
  assert.equal(readCursorFile(ud), (cursorF + 2) % AUTONOMOUS_HANDLERS.length);
  assert.equal(readAdaptiveFile(ud).skips.F, 1, 'F skip recorded');
  closeDb(db);
});

test('all handlers skipped → tick returns skipped, no spawn, lock released', async () => {
  // Empty DB → B/G/L always run, so to skip ALL we point the loop at the gated
  // handlers only by benching B/G/L far into the future and emptying the DB so
  // D/E/F/H/K skip. Simplest: bench B/G/L, leave the DB empty.
  const ud = tmpUserData();
  const db = freshDb();
  writeAdaptiveFile(ud, {
    rotation: 0,
    benches: {
      B: { until: 99, at: '2000-01-01T00:00:00.000Z' },
      G: { until: 99, at: '2000-01-01T00:00:00.000Z' },
      L: { until: 99, at: '2000-01-01T00:00:00.000Z' },
    },
    skips: {},
  });
  const { calls, fn } = spySpawn();
  const r = await runAgentRunner(fakeCtx(db), enabledDeps(ud, fn));

  assert.equal(r.status, 'skipped');
  assert.equal(calls.length, 0, 'no handler runnable → no spawn');
  assert.equal(lockExists(ud), false, 'a fully-skipped tick must release the lock');
  closeDb(db);
});

// ===========================================================================
// Adaptive dispatch — 3-strikes benching (spec §B4)
// ===========================================================================

test('3 consecutive failures bench a handler for 3 rotations + fire an alert', async () => {
  const ud = tmpUserData();
  const db = freshDb();
  // Cursor at B so B is examined first. 3 error rows → bench B, dispatch next runnable.
  writeCursorFile(ud, idxOf('B'));
  seedUsage(db, 'B', [
    { status: 'error', ts: '2026-06-01T00:00:00.000Z' },
    { status: 'error', ts: '2026-06-02T00:00:00.000Z' },
    { status: 'error', ts: '2026-06-03T00:00:00.000Z' },
  ]);
  const { calls, fn } = spySpawn();
  const r = await runAgentRunner(
    fakeCtx(db, () => new Date('2026-06-11T00:00:00.000Z')),
    enabledDeps(ud, fn),
  );

  assert.equal(r.status, 'ok', 'a runnable handler after B should still dispatch');
  assert.notEqual(dispatchedId(calls[0]), 'B', 'benched handler must not be spawned');
  const adaptive = readAdaptiveFile(ud);
  assert.equal(adaptive.benches.B?.until, 0 + 3, 'B benched for 3 rotations from rotation 0');
  const open = listAlerts(db, { all: false });
  assert.ok(
    open.some((a) => a.source === 'agent-runner' && a.key === 'handler-benched:B'),
    'an open bench alert must exist for B',
  );
  closeDb(db);
});

test('outcome-mismatch rows count as failures for the streak', async () => {
  const ud = tmpUserData();
  const db = freshDb();
  writeCursorFile(ud, idxOf('B'));
  seedUsage(db, 'B', [
    { status: 'success', verified: 'outcome-mismatch', ts: '2026-06-01T00:00:00.000Z' },
    { status: 'success', verified: 'outcome-mismatch', ts: '2026-06-02T00:00:00.000Z' },
    { status: 'success', verified: 'outcome-mismatch', ts: '2026-06-03T00:00:00.000Z' },
  ]);
  const { calls, fn } = spySpawn();
  const r = await runAgentRunner(
    fakeCtx(db, () => new Date('2026-06-11T00:00:00.000Z')),
    enabledDeps(ud, fn),
  );

  assert.equal(r.status, 'ok');
  assert.notEqual(dispatchedId(calls[0]), 'B', 'mismatch-streak benches B');
  assert.equal(readAdaptiveFile(ud).benches.B?.until, 3);
  closeDb(db);
});

test('benched handler is skipped until the bench expires, then runs again', async () => {
  const ud = tmpUserData();
  const db = freshDb();
  writeCursorFile(ud, idxOf('B'));

  // rotation 0 < until 3 → B skipped; next runnable (G) dispatched.
  writeAdaptiveFile(ud, {
    rotation: 0,
    benches: { B: { until: 3, at: '2026-06-01T00:00:00.000Z' } },
    skips: {},
  });
  {
    const { calls, fn } = spySpawn();
    const r = await runAgentRunner(
      fakeCtx(db, () => BASE),
      enabledDeps(ud, fn),
    );
    assert.equal(r.status, 'ok');
    assert.notEqual(dispatchedId(calls[0]), 'B', 'benched B is skipped while rotation < until');
  }

  // rotation now >= until and NO post-watermark failures → B dispatches again.
  // Time advances past the stale window so this tick steals the prior lock.
  writeCursorFile(ud, idxOf('B'));
  writeAdaptiveFile(ud, {
    rotation: 3,
    benches: { B: { until: 3, at: '2026-06-01T00:00:00.000Z' } },
    skips: {},
  });
  {
    const { calls, fn } = spySpawn();
    const later = () => new Date(BASE.getTime() + 60 * 60_000);
    const r = await runAgentRunner(fakeCtx(db, later), enabledDeps(ud, fn));
    assert.equal(r.status, 'ok');
    assert.equal(dispatchedId(calls[0]), 'B', 'expired bench → B runs again');
  }
  closeDb(db);
});

test('expired bench does not instantly re-bench on the same old failures', async () => {
  const ud = tmpUserData();
  const db = freshDb();
  writeCursorFile(ud, idxOf('B'));
  // 3 old failures predate the bench watermark → must NOT count.
  seedUsage(db, 'B', [
    { status: 'error', ts: '2026-05-01T00:00:00.000Z' },
    { status: 'error', ts: '2026-05-02T00:00:00.000Z' },
    { status: 'error', ts: '2026-05-03T00:00:00.000Z' },
  ]);
  writeAdaptiveFile(ud, {
    rotation: 3,
    benches: { B: { until: 3, at: '2026-06-01T00:00:00.000Z' } },
    skips: {},
  });
  const { calls, fn } = spySpawn();
  const r = await runAgentRunner(fakeCtx(db), enabledDeps(ud, fn));

  assert.equal(r.status, 'ok');
  assert.equal(dispatchedId(calls[0]), 'B', 'old pre-watermark failures must not re-bench B');
  // Entry is NOT cleared on bench expiry alone (no observed post-bench success),
  // but it is NOT renewed either: the watermark filters the old failures out, so
  // the streak check finds nothing post-watermark → no re-bench. The original
  // expired entry survives untouched (same `until`) and serves only as the
  // watermark; the alert stays open until a real post-bench success.
  assert.equal(
    readAdaptiveFile(ud).benches.B?.until,
    3,
    'expired bench retained as watermark, not renewed',
  );
  closeDb(db);
});

test('a success after the bench resolves the alert and clears the bench entry', async () => {
  const ud = tmpUserData();
  const db = freshDb();
  writeCursorFile(ud, idxOf('B'));
  // An open bench alert + a post-watermark success row.
  db.prepare(
    `INSERT INTO alerts (severity, source, key, message, first_seen_at, last_seen_at)
     VALUES ('warning', 'agent-runner', 'handler-benched:B', 'benched', datetime('now'), datetime('now'))`,
  ).run();
  seedUsage(db, 'B', [{ status: 'success', verified: 'verified', ts: '2026-06-05T00:00:00.000Z' }]);
  writeAdaptiveFile(ud, {
    rotation: 3,
    benches: { B: { until: 3, at: '2026-06-01T00:00:00.000Z' } },
    skips: {},
  });
  const { calls, fn } = spySpawn();
  const r = await runAgentRunner(fakeCtx(db), enabledDeps(ud, fn));

  assert.equal(r.status, 'ok');
  assert.equal(dispatchedId(calls[0]), 'B', 'post-bench success → B runs');
  assert.equal(readAdaptiveFile(ud).benches.B, undefined, 'bench entry cleared on success');
  // Alert resolved (no longer in the open list).
  const open = listAlerts(db, { all: false });
  assert.ok(!open.some((a) => a.key === 'handler-benched:B'), 'the bench alert must be resolved');
  closeDb(db);
});

test('expired bench without a post-bench run keeps the entry and the alert open, but dispatches the handler', async () => {
  const ud = tmpUserData();
  const db = freshDb();
  writeCursorFile(ud, idxOf('B'));
  // An open bench alert, NO post-watermark agent_usage rows for B, empty DB so B
  // (which has no pre-check gate) is the dispatched handler.
  db.prepare(
    `INSERT INTO alerts (severity, source, key, message, first_seen_at, last_seen_at)
     VALUES ('warning', 'agent-runner', 'handler-benched:B', 'benched', datetime('now'), datetime('now'))`,
  ).run();
  writeAdaptiveFile(ud, {
    rotation: 3,
    benches: { B: { until: 3, at: '2026-06-01T00:00:00.000Z' } },
    skips: {},
  });
  const { calls, fn } = spySpawn();
  const r = await runAgentRunner(fakeCtx(db), enabledDeps(ud, fn));

  assert.equal(r.status, 'ok');
  assert.equal(dispatchedId(calls[0]), 'B', 'an expired bench no longer blocks dispatch');
  // No observed post-bench success → entry stays as the streak watermark.
  assert.equal(
    readAdaptiveFile(ud).benches.B?.until,
    3,
    'entry retained (watermark) when no post-bench run has happened',
  );
  // Alert stays open — bench expiry is no evidence the handler recovered.
  const open = listAlerts(db, { all: false });
  assert.ok(
    open.some((a) => a.source === 'agent-runner' && a.key === 'handler-benched:B'),
    'the bench alert must stay open until an observed post-bench success',
  );
  closeDb(db);
});

test('expired bench with a post-bench FAILURE keeps the alert open', async () => {
  const ud = tmpUserData();
  const db = freshDb();
  writeCursorFile(ud, idxOf('B'));
  // An open bench alert + a SINGLE post-watermark error row (one failure, not a
  // fresh 3-streak): the latest post-bench run failed, so no recovery is observed.
  db.prepare(
    `INSERT INTO alerts (severity, source, key, message, first_seen_at, last_seen_at)
     VALUES ('warning', 'agent-runner', 'handler-benched:B', 'benched', datetime('now'), datetime('now'))`,
  ).run();
  seedUsage(db, 'B', [{ status: 'error', ts: '2026-06-05T00:00:00.000Z' }]);
  writeAdaptiveFile(ud, {
    rotation: 3,
    benches: { B: { until: 3, at: '2026-06-01T00:00:00.000Z' } },
    skips: {},
  });
  const { calls, fn } = spySpawn();
  const r = await runAgentRunner(fakeCtx(db), enabledDeps(ud, fn));

  assert.equal(r.status, 'ok');
  // Latest post-watermark run failed → entry NOT cleared. The streak check (with
  // the watermark) sees only 1 post-watermark failure → no re-bench → B dispatches.
  assert.equal(dispatchedId(calls[0]), 'B', 'a single post-bench failure does not re-bench');
  assert.equal(
    readAdaptiveFile(ud).benches.B?.until,
    3,
    'entry retained (watermark) after a post-bench failure',
  );
  const open = listAlerts(db, { all: false });
  assert.ok(
    open.some((a) => a.source === 'agent-runner' && a.key === 'handler-benched:B'),
    'a post-bench failure must keep the alert open',
  );
  closeDb(db);
});

// ===========================================================================
// Rotation accounting + corruption resilience
// ===========================================================================

test('rotation counter increments when the cursor wraps', async () => {
  // Seed all handlers runnable. Cursor at L (last, index 7). L runs → steps 1 →
  // (7 + 1) = 8 → wraps once → rotation += 1, cursor → 0.
  const ud = tmpUserData();
  const db = freshDb();
  seedAllRunnable(db, ud);
  writeAdaptiveFile(ud, { rotation: 5, benches: {}, skips: {} });
  writeCursorFile(ud, idxOf('L'));
  const { calls, fn } = spySpawn();
  const r = await runAgentRunner(fakeCtx(db), enabledDeps(ud, fn));

  assert.equal(r.status, 'ok');
  assert.equal(dispatchedId(calls[0]), 'L');
  assert.equal(readCursorFile(ud), 0, 'cursor wraps to 0 after L');
  assert.equal(readAdaptiveFile(ud).rotation, 6, 'one wrap → rotation incremented by 1');
  closeDb(db);
});

test('corrupt adaptive-state file resets cleanly (no throw)', async () => {
  const ud = tmpUserData();
  const db = freshDb();
  // Garbage JSON at the adaptive path.
  mkdirSync(join(ud, 'state', 'runtime'), { recursive: true });
  writeFileSync(adaptivePath(ud), '{not valid json', 'utf8');
  const { calls, fn } = spySpawn();
  const r = await runAgentRunner(fakeCtx(db), enabledDeps(ud, fn));

  assert.equal(r.status, 'ok', 'corrupt state must not throw — it resets');
  assert.equal(dispatchedId(calls[0]), 'B', 'fresh state → cursor 0 → B dispatched');
  const adaptive = readAdaptiveFile(ud);
  assert.equal(adaptive.rotation, 0);
  assert.deepEqual(adaptive.benches, {});
  closeDb(db);
});
