import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeCtx } from '../../../runtime/invariants/ctx.js';
import { run } from '../../../runtime/invariants/runner.js';
import { readState } from '../../../runtime/invariants/state.js';
import { makeFakeInvariant, withTempStateFile } from '../../helpers/invariant-fixtures.js';

test('boot runs in phase order: paths → db → mcp → integrations → runtime → meta', () =>
  withTempStateFile(async ({ statePath, lockDir }) => {
    const trace = [];
    const phases = ['meta', 'runtime', 'integrations', 'mcp', 'db', 'paths']; // intentionally reversed
    const invariants = phases.map((p) =>
      makeFakeInvariant({
        name: `${p}.t`,
        phase: p,
        check: async () => ({ ok: true }),
      }),
    );
    // patch check to record
    for (const inv of invariants) {
      const phase = inv.phase;
      inv.check = async () => {
        trace.push(phase);
        return { ok: true };
      };
    }
    const ctx = makeCtx({ logFallback: false });
    await run({ trigger: 'boot', ctx, statePath, lockDir, invariants });
    assert.deepEqual(trace, ['paths', 'db', 'mcp', 'integrations', 'runtime', 'meta']);
  }));

test('boot aborts after a critical failure', () =>
  withTempStateFile(async ({ statePath, lockDir }) => {
    const trace = [];
    const inv1 = makeFakeInvariant({
      name: 'paths.fail',
      level: 'critical',
      phase: 'paths',
      checkResult: { ok: false, error: 'broken' },
    });
    inv1.check = async () => {
      trace.push('inv1');
      return { ok: false, error: 'broken' };
    };
    const inv2 = makeFakeInvariant({ name: 'db.next', phase: 'db' });
    inv2.check = async () => {
      trace.push('inv2');
      return { ok: true };
    };
    const ctx = makeCtx({ logFallback: false });
    const report = await run({
      trigger: 'boot',
      ctx,
      statePath,
      lockDir,
      invariants: [inv1, inv2],
    });
    assert.equal(report.aborted, true);
    assert.deepEqual(trace, ['inv1']); // inv2 never ran
  }));

test('boot allows repair for bootRepairAllowlist entries', () =>
  withTempStateFile(async ({ statePath, lockDir }) => {
    let repairCalls = 0;
    const inv = makeFakeInvariant({
      name: 'paths.allowed',
      level: 'critical',
      phase: 'paths',
    });
    inv.check = async () => ({ ok: false, error: 'x' });
    inv.repair = async () => {
      repairCalls++;
      return { repaired: true, action: 'fixed' };
    };
    const ctx = makeCtx({ logFallback: false });
    const report = await run({
      trigger: 'boot',
      ctx,
      statePath,
      lockDir,
      invariants: [inv],
      repairAllowlist: ['paths.allowed'],
    });
    assert.equal(repairCalls, 1);
    assert.equal(report.aborted, false);
  }));

test('heartbeat skips invariants with active cooldown', () =>
  withTempStateFile(async ({ statePath, lockDir }) => {
    let checks = 0;
    const inv = makeFakeInvariant({
      name: 'test.cool',
      runWhen: { heartbeat: { enabled: true, cooldownMs: 60_000 } },
    });
    inv.check = async () => {
      checks++;
      return { ok: true };
    };
    const ctx = makeCtx({ logFallback: false });
    // First run — no cooldown record, should run
    await run({ trigger: 'heartbeat', ctx, statePath, lockDir, invariants: [inv] });
    assert.equal(checks, 1);
    // Immediate second run — cooldown should suppress
    await run({ trigger: 'heartbeat', ctx, statePath, lockDir, invariants: [inv] });
    assert.equal(checks, 1, 'second run suppressed by cooldown');
  }));

test('heartbeat passes ctx to inv.enabled() so db-gated invariants can read state', () =>
  // Regression: earlier code called `inv.enabled()` with no args, so invariants
  // that gated on ctx.db (integrations.sync_freshness, integrations.no_stuck_in_flight,
  // lunch_money.no_dupes) returned false at every tick and showed NEVER_RUN forever.
  withTempStateFile(async ({ statePath, lockDir }) => {
    const seenCtx = [];
    const inv = {
      name: 'test.ctx-aware',
      level: 'warn',
      phase: 'runtime',
      surface: 'test',
      description: 'gates on ctx.db',
      runWhen: { heartbeat: { enabled: true, cooldownMs: 0 } },
      async enabled(ctx) {
        seenCtx.push(ctx);
        return ctx?.db === SENTINEL_DB;
      },
      async check() {
        return { ok: true };
      },
    };
    const SENTINEL_DB = { _id: 'sentinel-db' };
    const ctx = makeCtx({ db: SENTINEL_DB, logFallback: false });
    await run({ trigger: 'heartbeat', ctx, statePath, lockDir, invariants: [inv] });
    assert.equal(seenCtx.length, 1, 'enabled() was invoked');
    assert.equal(seenCtx[0]?.db, SENTINEL_DB, 'enabled() received the same ctx the runner uses');
  }));

test('heartbeat allSettled isolates one slow invariant from others', () =>
  withTempStateFile(async ({ statePath, lockDir }) => {
    const fast = makeFakeInvariant({ name: 'fast' });
    const slow = makeFakeInvariant({ name: 'slow', checkDelayMs: 10_000 });
    let fastChecked = false;
    fast.check = async () => {
      fastChecked = true;
      return { ok: true };
    };
    const ctx = makeCtx({ logFallback: false });
    const start = Date.now();
    const report = await run({
      trigger: 'heartbeat',
      ctx,
      statePath,
      lockDir,
      invariants: [fast, slow],
    });
    const elapsed = Date.now() - start;
    assert.ok(fastChecked, 'fast invariant ran');
    assert.ok(elapsed < 3000, `should not wait for slow check; elapsed=${elapsed}`);
    const slowResult = report.results.find((r) => r.name === 'slow');
    assert.ok(slowResult.status === 'fail' || slowResult.status === 'error');
  }));

test('postInstall resets consecutive_failures', () =>
  withTempStateFile(async ({ statePath, lockDir }) => {
    const inv = makeFakeInvariant({ name: 'test.reset' });
    inv.check = async () => ({ ok: true });
    // Seed state with prior failures
    const seedState = {
      invariants: {
        'test.reset': {
          last_checked_at: 100,
          last_pass_at: null,
          last_failure_at: 100,
          consecutive_failures: 5,
          pending_repair_at: null,
          last_result_summary: { ok: false },
          last_repair_at: null,
          last_repair_outcome: null,
          repair_history_30d: [],
        },
      },
      generated_at: null,
    };
    const { writeState } = await import('../../../runtime/invariants/state.js');
    writeState(statePath, seedState);
    const ctx = makeCtx({ logFallback: false });
    await run({ trigger: 'postInstall', ctx, statePath, lockDir, invariants: [inv] });
    const after = readState(statePath);
    assert.equal(after.invariants['test.reset'].consecutive_failures, 0);
  }));

test('doctor with name scope only runs that invariant', () =>
  withTempStateFile(async ({ statePath, lockDir }) => {
    let aChecks = 0;
    let bChecks = 0;
    const a = makeFakeInvariant({ name: 'a' });
    a.check = async () => {
      aChecks++;
      return { ok: true };
    };
    const b = makeFakeInvariant({ name: 'b' });
    b.check = async () => {
      bChecks++;
      return { ok: true };
    };
    const ctx = makeCtx({ logFallback: false });
    await run({ trigger: 'doctor', ctx, statePath, lockDir, invariants: [a, b], name: 'b' });
    assert.equal(aChecks, 0);
    assert.equal(bChecks, 1);
  }));

test('cli preflight reads cached state without re-checking', () =>
  withTempStateFile(async ({ statePath, lockDir }) => {
    let checks = 0;
    const inv = makeFakeInvariant({ name: 'cli.cached' });
    inv.check = async () => {
      checks++;
      return { ok: true };
    };
    const { writeState } = await import('../../../runtime/invariants/state.js');
    // Seed with a recent pass
    const seed = {
      invariants: {
        'cli.cached': {
          last_checked_at: Date.now(),
          last_pass_at: Date.now(),
          last_failure_at: null,
          consecutive_failures: 0,
          pending_repair_at: null,
          last_result_summary: { ok: true },
          last_repair_at: null,
          last_repair_outcome: null,
          repair_history_30d: [],
        },
      },
      generated_at: null,
    };
    writeState(statePath, seed);
    const ctx = makeCtx({ logFallback: false });
    await run({
      trigger: 'cli',
      ctx,
      statePath,
      lockDir,
      invariants: [inv],
      cliBlockingSet: ['cli.cached'],
    });
    assert.equal(checks, 0, 'fresh cache, no re-check');
  }));

test('cli preflight re-checks when blocking and cache stale', () =>
  withTempStateFile(async ({ statePath, lockDir }) => {
    let checks = 0;
    const inv = makeFakeInvariant({ name: 'cli.stale' });
    inv.check = async () => {
      checks++;
      return { ok: false, error: 'broken' };
    };
    const ctx = makeCtx({ logFallback: false });
    const report = await run({
      trigger: 'cli',
      ctx,
      statePath,
      lockDir,
      invariants: [inv],
      cliBlockingSet: ['cli.stale'],
    });
    assert.equal(checks, 1);
    assert.deepEqual(report.blocked, ['cli.stale']);
  }));
