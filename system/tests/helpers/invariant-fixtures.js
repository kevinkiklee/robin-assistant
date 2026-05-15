// Fixture helpers for invariant tests.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCtx } from '../../runtime/invariants/ctx.js';

/**
 * makeCtx wrapper that defaults to non-fallback (silent) logging and a frozen
 * dry-run flag. Tests pass overrides to assert on specific paths.
 */
export function makeTestCtx(overrides = {}) {
  return makeCtx({
    logFallback: false,
    ...overrides,
  });
}

/**
 * Run check + (optionally) repair + explain against fixtures.
 */
export async function runOneInvariant(inv, ctx, { repair = false } = {}) {
  const enabled = typeof inv.enabled === 'function' ? await inv.enabled(ctx) : true;
  if (!enabled) return { enabled: false };
  const check = await inv.check(ctx);
  let repairOutcome = null;
  if (repair && !check.ok && inv.repair) {
    repairOutcome = await inv.repair(ctx);
  }
  const explain = typeof inv.explain === 'function' ? inv.explain(check) : null;
  return { enabled: true, check, repair: repairOutcome, explain };
}

/**
 * Provide a tempdir with state file + lock dir paths for tests. Cleans up after.
 */
export function withTempStateFile(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'robin-invariants-'));
  const statePath = join(dir, 'invariants-state.json');
  const lockDir = join(dir, 'locks');
  mkdirSync(lockDir, { recursive: true });
  return Promise.resolve(fn({ dir, statePath, lockDir })).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

/**
 * A minimal in-memory invariant useful in runner tests.
 */
export function makeFakeInvariant({
  name = 'test.fake',
  level = 'warn',
  phase = 'runtime',
  surface = 'test',
  enabled = true,
  checkResult = { ok: true },
  repairResult = { repaired: true, action: 'test_repair' },
  checkDelayMs = 0,
  repairDelayMs = 0,
  runWhen = {
    boot: { enabled: true },
    heartbeat: { enabled: true, cooldownMs: 0 },
    doctor: { enabled: true },
    postInstall: { enabled: true },
  },
} = {}) {
  return {
    name,
    level,
    phase,
    surface,
    description: 'fake test invariant',
    runWhen,
    enabled() {
      return enabled;
    },
    async check() {
      if (checkDelayMs) await new Promise((r) => setTimeout(r, checkDelayMs).unref?.());
      return checkResult;
    },
    async repair() {
      if (repairDelayMs) await new Promise((r) => setTimeout(r, repairDelayMs).unref?.());
      return repairResult;
    },
    explain() {
      return `## ${name}\nfake`;
    },
  };
}
