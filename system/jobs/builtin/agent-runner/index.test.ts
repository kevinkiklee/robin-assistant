import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquire } from '../../../agent/single-flight.ts';
import type { JobContext } from '../../_runtime/types.ts';
import {
  type AgentRunnerDeps,
  AUTONOMOUS_HANDLERS,
  lockExists,
  runAgentRunner,
  type SpawnFn,
} from './index.ts';

/** A throwaway user-data dir; state/runtime is created lazily by the job. */
function tmpUserData(): string {
  return mkdtempSync(join(tmpdir(), 'robin-agent-runner-'));
}

/** Minimal JobContext — the job only touches `now` and `log`. */
function fakeCtx(now: () => Date = () => new Date(0)): JobContext {
  const noop = () => {};
  return {
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

test('agent-runner: skipped (no spawn) when agent.enabled is false', async () => {
  const ud = tmpUserData();
  const { calls, fn } = spySpawn();
  const r = await runAgentRunner(fakeCtx(), {
    ...enabledDeps(ud, fn),
    isEnabled: () => false,
  });
  assert.equal(r.status, 'skipped');
  assert.equal(calls.length, 0, 'a disabled runner must never spawn');
});

test('agent-runner: defaults to disabled when no policies/config exists', async () => {
  // No isEnabled override → reads agent.enabled from policies, which defaults OFF.
  const ud = tmpUserData();
  const { calls, fn } = spySpawn();
  const r = await runAgentRunner(fakeCtx(), {
    userDataDir: ud,
    spawn: fn,
    runnerEntryPath: () => RUNNER_ENTRY,
  });
  assert.equal(r.status, 'skipped');
  assert.equal(calls.length, 0, 'agent is opt-in: a config-less instance never spawns');
});

test('agent-runner: spawns a detached child + returns ok', async () => {
  const ud = tmpUserData();
  const { calls, fn } = spySpawn();
  const r = await runAgentRunner(fakeCtx(), enabledDeps(ud, fn));
  assert.equal(r.status, 'ok');
  assert.equal(calls.length, 1, 'exactly one detached child per tick');
  // Detached + no stdio inheritance — the daemon never blocks on the child.
  assert.deepEqual(calls[0]?.opts, { detached: true, stdio: 'ignore' });
});

test('agent-runner: argv targets runner-entry with a handler id', async () => {
  const ud = tmpUserData();
  const { calls, fn } = spySpawn();
  await runAgentRunner(fakeCtx(), enabledDeps(ud, fn));
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
});

test('agent-runner: returns skipped (no spawn) when the lock is held', async () => {
  const ud = tmpUserData();
  // Pre-seed a fresh lock so the job's acquire() must fail.
  acquire(join(ud, 'state', 'runtime', 'agent-runner.lock'), {
    staleMs: 45 * 60_000,
    now: () => 0,
    pid: 999,
  });
  const { calls, fn } = spySpawn();
  const r = await runAgentRunner(
    fakeCtx(() => new Date(60_000)),
    enabledDeps(ud, fn),
  );
  assert.equal(r.status, 'skipped');
  assert.equal(calls.length, 0, 'a held lock must prevent any spawn');
});

test('agent-runner: round-robin advances the handler across ticks', async () => {
  const ud = tmpUserData();
  const ids: string[] = [];
  // Run as many ticks as there are handlers, releasing the lock between each so
  // every tick acquires cleanly. Time advances past the stale window per tick.
  for (let i = 0; i < AUTONOMOUS_HANDLERS.length; i++) {
    const { calls, fn } = spySpawn();
    // Each tick uses a time far past any prior lock so acquire steals/succeeds.
    await runAgentRunner(
      fakeCtx(() => new Date(i * 60 * 60_000)),
      enabledDeps(ud, fn),
    );
    const flag = calls[0]?.args[3] ?? '';
    ids.push(flag.split('=')[1] ?? '');
  }
  // Cursor persists, so the sequence is the full fixed rotation in order.
  assert.deepEqual(ids, [...AUTONOMOUS_HANDLERS]);
});

test('agent-runner: spawn failure returns error (lock recovered via stale-steal)', async () => {
  const ud = tmpUserData();
  const throwingSpawn = (() => {
    throw new Error('spawn ENOENT');
  }) as unknown as SpawnFn;
  const r = await runAgentRunner(fakeCtx(), enabledDeps(ud, throwingSpawn));
  assert.equal(r.status, 'error');
  // Lock is left held in this impl only if acquired; assert it still exists so a
  // stale-steal (not a permanent wedge) is what recovers it next tick.
  assert.equal(lockExists(ud), true);
});

test('agent-runner: cursor file persists the next position', async () => {
  const ud = tmpUserData();
  const { fn } = spySpawn();
  await runAgentRunner(fakeCtx(), enabledDeps(ud, fn));
  const cursor = readFileSync(join(ud, 'state', 'runtime', 'agent-runner-cursor'), 'utf8').trim();
  assert.equal(cursor, '1', 'after one tick the cursor advances to 1');
});
