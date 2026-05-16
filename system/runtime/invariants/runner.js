// The invariant runner. Single entry point: run({ trigger, options }).
//
// Triggers:
//   - 'boot'        : ordered by phase; first failure of a critical invariant aborts the run.
//                     Resets consecutive_failures (fresh-world event).
//   - 'heartbeat'   : parallel within phase via allSettled+timeout; cooldown-gated.
//   - 'doctor'      : bypass cooldown; --repair invocations always re-check first.
//   - 'postInstall' : sequential; auto-repair allowed; resets failure counters.
//   - 'cli'         : preflight; read-only state file; never re-checks unless in cliBlockingSet
//                     and cache is stale.

import { byPhase, getAllInvariants } from './index.js';
import { withLock } from './lock.js';
import { BOOT_REPAIR_ALLOWLIST, CLI_BLOCKING_SET, PHASES } from './policy.js';
import { decideRepair } from './policy-decisions.js';
import {
  emptyState,
  getEntry,
  readState,
  recordCheckResult,
  recordRepairResult,
  resetFailureCount,
  setEntry,
  writeState,
} from './state.js';

const PER_CHECK_TIMEOUT_MS = 2_000;
const BOOT_TOTAL_BUDGET_MS = 5_000;
const SLOW_CHECK_THRESHOLD_MS = 500;
const _CLI_PREFLIGHT_BUDGET_MS = 30;
const CLI_BLOCKING_RECHECK_BUDGET_MS = 200;

function nowMs() {
  return Date.now();
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout:${label}`)), ms);
    t.unref?.();
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function evaluateOne(inv, ctx, opts = {}) {
  const start = nowMs();
  let checkResult;
  try {
    checkResult = await withTimeout(
      inv.check(ctx),
      opts.checkTimeoutMs ?? PER_CHECK_TIMEOUT_MS,
      inv.name,
    );
  } catch (e) {
    checkResult = { ok: false, error: e.message ?? String(e) };
  }
  const elapsed = nowMs() - start;
  if (elapsed > SLOW_CHECK_THRESHOLD_MS) {
    ctx.log?.warn?.(`slow_check name=${inv.name} ms=${elapsed} trigger=${ctx.trigger}`);
  }
  return { checkResult, elapsedMs: elapsed };
}

async function maybeRepair(inv, entry, ctx, lockDir) {
  const decision = decideRepair(inv, {
    ...entry,
    consecutive_failures: entry.consecutive_failures + 1,
  });
  if (decision !== 'auto') return { repaired: false, action: 'skipped', decision };
  if (!inv.repair) return { repaired: false, action: 'no_repair_defined', decision };
  if (lockDir) {
    const outcome = await withLock(lockDir, inv.name, () => inv.repair(ctx));
    if (!outcome.acquired) return { repaired: false, action: 'lock_held_by_other', decision };
    return { ...outcome.result, decision };
  }
  const result = await inv.repair(ctx);
  return { ...result, decision };
}

async function shouldRun(inv, triggerCfg, entry, trigger) {
  if (!triggerCfg?.enabled) return false;
  if (typeof inv.enabled === 'function') {
    try {
      const ok = await inv.enabled();
      if (!ok) return false;
    } catch {
      return false;
    }
  }
  if (trigger === 'heartbeat' && triggerCfg.cooldownMs) {
    const last = entry.last_checked_at ?? 0;
    if (last + triggerCfg.cooldownMs > nowMs()) return false;
  }
  return true;
}

/** Boot: phase-ordered, sequential. Critical failure aborts. */
async function runBoot({
  ctx,
  state,
  stateWritePath,
  lockDir,
  invariants,
  repairAllowlist,
  bootTotalBudgetMs,
}) {
  const started = nowMs();
  const grouped = byPhase(invariants);
  const report = { trigger: 'boot', results: [], aborted: false };

  for (const phase of PHASES) {
    for (const inv of grouped.get(phase) ?? []) {
      if (bootTotalBudgetMs != null && nowMs() - started > bootTotalBudgetMs) {
        ctx.log?.warn?.(`boot_budget_exceeded after ${inv.name}`);
        report.aborted = true;
        break;
      }
      let entry = getEntry(state, inv.name);
      entry = resetFailureCount(entry); // boot resets
      const triggerCfg = inv.runWhen?.boot;
      const skip = !(await shouldRun(inv, triggerCfg, entry, 'boot'));
      if (skip) {
        report.results.push({ name: inv.name, status: 'skipped' });
        setEntry(state, inv.name, entry);
        continue;
      }
      const { checkResult } = await evaluateOne(inv, { ...ctx, trigger: 'boot' });
      entry = recordCheckResult(entry, checkResult);
      let repairOutcome = null;
      if (!checkResult.ok && repairAllowlist.includes(inv.name)) {
        repairOutcome = await maybeRepair(inv, entry, { ...ctx, trigger: 'boot' }, lockDir);
        entry = recordRepairResult(entry, repairOutcome);
      }
      setEntry(state, inv.name, entry);
      report.results.push({
        name: inv.name,
        status: checkResult.ok ? 'ok' : 'fail',
        repaired: repairOutcome?.repaired ?? false,
        level: inv.level,
        error: checkResult.error,
      });
      if (!checkResult.ok && inv.level === 'critical' && !repairOutcome?.repaired) {
        report.aborted = true;
        break;
      }
    }
    if (report.aborted) break;
  }

  if (stateWritePath) writeState(stateWritePath, state);
  return report;
}

/** Heartbeat: parallel within phase via allSettled+timeout. Cooldown-gated from state file. */
async function runHeartbeat({ ctx, state, stateWritePath, lockDir, invariants }) {
  const due = [];
  for (const inv of invariants) {
    const entry = getEntry(state, inv.name);
    if (await shouldRun(inv, inv.runWhen?.heartbeat, entry, 'heartbeat')) due.push(inv);
  }

  const results = await Promise.allSettled(
    due.map((inv) => evaluateOne(inv, { ...ctx, trigger: 'heartbeat' })),
  );
  const report = { trigger: 'heartbeat', results: [] };
  for (let i = 0; i < due.length; i++) {
    const inv = due[i];
    const settled = results[i];
    let entry = getEntry(state, inv.name);
    if (settled.status === 'rejected') {
      entry = recordCheckResult(entry, {
        ok: false,
        error: settled.reason?.message ?? String(settled.reason),
      });
      setEntry(state, inv.name, entry);
      report.results.push({
        name: inv.name,
        status: 'error',
        error: entry.last_result_summary?.error,
      });
      continue;
    }
    const { checkResult } = settled.value;
    entry = recordCheckResult(entry, checkResult);
    let repairOutcome = null;
    if (!checkResult.ok) {
      repairOutcome = await maybeRepair(inv, entry, { ...ctx, trigger: 'heartbeat' }, lockDir);
      entry = recordRepairResult(entry, repairOutcome);
      if (repairOutcome.decision === 'auto' && !repairOutcome.repaired && !repairOutcome.error) {
        entry.pending_repair_at = new Date(nowMs() + 60_000).toISOString();
      }
    }
    setEntry(state, inv.name, entry);
    report.results.push({
      name: inv.name,
      status: checkResult.ok ? 'ok' : 'fail',
      level: inv.level,
      repaired: repairOutcome?.repaired ?? false,
      decision: repairOutcome?.decision,
    });
  }
  if (stateWritePath) writeState(stateWritePath, state);
  return report;
}

/** PostInstall: sequential; auto-repair allowed; resets failure counters. */
async function runPostInstall({ ctx, state, stateWritePath, lockDir, invariants }) {
  const report = { trigger: 'postInstall', results: [] };
  for (const inv of invariants) {
    let entry = getEntry(state, inv.name);
    entry = resetFailureCount(entry);
    if (!(await shouldRun(inv, inv.runWhen?.postInstall, entry, 'postInstall'))) {
      setEntry(state, inv.name, entry);
      continue;
    }
    const { checkResult } = await evaluateOne(inv, { ...ctx, trigger: 'postInstall' });
    entry = recordCheckResult(entry, checkResult);
    let repairOutcome = null;
    if (!checkResult.ok) {
      repairOutcome = await maybeRepair(inv, entry, { ...ctx, trigger: 'postInstall' }, lockDir);
      entry = recordRepairResult(entry, repairOutcome);
    }
    setEntry(state, inv.name, entry);
    report.results.push({
      name: inv.name,
      status: checkResult.ok ? 'ok' : 'fail',
      level: inv.level,
      repaired: repairOutcome?.repaired ?? false,
    });
  }
  if (stateWritePath) writeState(stateWritePath, state);
  return report;
}

/** Doctor: re-check everything; bypass cooldown. With repair=true, run repair after check. */
async function runDoctor({
  ctx,
  state,
  stateWritePath,
  lockDir,
  invariants,
  repair = false,
  apply = false,
  namedSet = null,
}) {
  const report = { trigger: 'doctor', results: [] };
  for (const inv of invariants) {
    if (namedSet && !namedSet.has(inv.name)) continue;
    let entry = getEntry(state, inv.name);
    if (typeof inv.enabled === 'function') {
      try {
        if (!(await inv.enabled())) {
          report.results.push({ name: inv.name, status: 'skipped' });
          continue;
        }
      } catch {
        report.results.push({ name: inv.name, status: 'skipped' });
        continue;
      }
    }
    const { checkResult } = await evaluateOne(inv, { ...ctx, trigger: 'doctor' });
    entry = recordCheckResult(entry, checkResult);
    let repairOutcome = null;
    if (repair && !checkResult.ok && inv.repair) {
      const repairCtx = { ...ctx, trigger: 'doctor', dryRun: !apply };
      repairOutcome = await maybeRepair(inv, entry, repairCtx, apply ? lockDir : null);
      if (apply) entry = recordRepairResult(entry, repairOutcome);
    }
    setEntry(state, inv.name, entry);
    report.results.push({
      name: inv.name,
      status: checkResult.ok ? 'ok' : 'fail',
      level: inv.level,
      evidence: checkResult.evidence,
      error: checkResult.error,
      repair: repairOutcome,
    });
  }
  if (stateWritePath && apply) writeState(stateWritePath, state);
  return report;
}

/** CLI preflight: read-only state file; never re-checks unless cliBlockingSet AND cache stale. */
async function runCliPreflight({ state, invariants, cliBlockingSet, cacheStaleMs = 30_000, ctx }) {
  const report = { trigger: 'cli', results: [], blocked: [] };
  const now = nowMs();
  for (const inv of invariants) {
    const entry = getEntry(state, inv.name);
    const cached = entry.last_result_summary;
    const stale = !entry.last_checked_at || now - entry.last_checked_at > cacheStaleMs;
    if (cliBlockingSet.includes(inv.name) && stale) {
      // One fast re-check.
      const { checkResult } = await evaluateOne(
        inv,
        { ...ctx, trigger: 'cli' },
        { checkTimeoutMs: CLI_BLOCKING_RECHECK_BUDGET_MS },
      );
      report.results.push({
        name: inv.name,
        status: checkResult.ok ? 'ok' : 'fail',
        evidence: checkResult.evidence,
        error: checkResult.error,
      });
      if (!checkResult.ok) report.blocked.push(inv.name);
      continue;
    }
    if (cached) {
      report.results.push({ name: inv.name, status: cached.ok ? 'ok' : 'fail', cached: true });
      if (!cached.ok && cliBlockingSet.includes(inv.name)) report.blocked.push(inv.name);
    } else {
      report.results.push({ name: inv.name, status: 'unknown', cached: true });
    }
  }
  return report;
}

/**
 * Main entry. Returns a report object describing what ran and the outcomes.
 *
 * @param {object} opts
 * @param {'boot'|'heartbeat'|'doctor'|'postInstall'|'cli'} opts.trigger
 * @param {object} opts.ctx - The invariant context (see ctx.js)
 * @param {string} [opts.statePath] - Override state file path (test injection)
 * @param {string} [opts.lockDir] - Override lock directory (test injection)
 * @param {object[]} [opts.invariants] - Override invariant set (default: registry)
 * @param {string[]} [opts.repairAllowlist] - Override boot repair allowlist
 * @param {string[]} [opts.cliBlockingSet] - Override CLI blocking set
 * @param {string} [opts.name] - Scope doctor to a single invariant
 * @param {string} [opts.surface] - Scope doctor to a surface
 * @param {boolean} [opts.repair] - Doctor repair mode
 * @param {boolean} [opts.apply] - Doctor commit mode
 * @param {number} [opts.bootTotalBudgetMs]
 */
export async function run(opts) {
  const {
    trigger,
    ctx,
    statePath,
    lockDir,
    invariants,
    repairAllowlist = BOOT_REPAIR_ALLOWLIST,
    cliBlockingSet = CLI_BLOCKING_SET,
    name,
    surface,
    repair = false,
    apply = false,
    bootTotalBudgetMs = BOOT_TOTAL_BUDGET_MS,
  } = opts;
  // Default to static + per-integration invariants. Tests that pass an explicit
  // `invariants` array bypass the filesystem scan entirely.
  const resolved = invariants ?? (await getAllInvariants());

  const state = statePath ? readState(statePath) : emptyState();
  const scoped = (() => {
    if (name) return resolved.filter((i) => i.name === name);
    if (surface) return resolved.filter((i) => i.surface === surface);
    return resolved;
  })();

  switch (trigger) {
    case 'boot':
      return runBoot({
        ctx,
        state,
        stateWritePath: statePath,
        lockDir,
        invariants: scoped,
        repairAllowlist,
        bootTotalBudgetMs,
      });
    case 'heartbeat':
      return runHeartbeat({ ctx, state, stateWritePath: statePath, lockDir, invariants: scoped });
    case 'doctor': {
      const namedSet = name ? new Set([name]) : null;
      return runDoctor({
        ctx,
        state,
        stateWritePath: statePath,
        lockDir,
        invariants: scoped,
        repair,
        apply,
        namedSet,
      });
    }
    case 'postInstall':
      return runPostInstall({ ctx, state, stateWritePath: statePath, lockDir, invariants: scoped });
    case 'cli':
      return runCliPreflight({ state, invariants: scoped, cliBlockingSet, ctx });
    default:
      throw new Error(`unknown trigger: ${trigger}`);
  }
}
