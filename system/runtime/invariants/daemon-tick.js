// Builds the heartbeat-bucket tick body that runs invariants when the flag
// is non-false. Reads the flag each tick so a flip takes effect within one
// interval.

import { paths } from '../../config/data-store.js';
import { isRunnerActive, readInvariantsFlag } from './config.js';
import { makeCtx } from './ctx.js';
import { run } from './runner.js';

/**
 * @param {object} deps
 * @param {object} deps.db - SurrealDB client; may become null transiently during reconnect.
 * @param {() => Promise<object>} [deps.dbFactory] - Raw connection factory for db.* invariants.
 * @returns {() => Promise<void>} tick body suitable for a heartbeat bucket.
 */
export function createInvariantsTick({ db, dbFactory } = {}) {
  return async function invariantsTick() {
    const flag = await readInvariantsFlag();
    if (!isRunnerActive(flag)) return;
    const ctx = makeCtx({
      db,
      dbFactory,
      paths,
      trigger: 'heartbeat',
      logFallback: true,
    });
    try {
      await run({
        trigger: 'heartbeat',
        ctx,
        statePath: paths.data.invariantsState(),
        lockDir: paths.data.invariantsLocks(),
      });
    } catch (e) {
      // The runner itself swallows per-invariant failures via allSettled,
      // so an error here means a framework-level problem. Log and continue.
      console.warn(`[invariants/heartbeat] runner failed: ${e.message}`);
    }
  };
}

/**
 * One-shot boot-time invariants run. Returns the report. Throws on
 * critical-abort so the daemon's boot path can surface it.
 */
export async function runBootInvariants({ db, dbFactory } = {}) {
  const flag = await readInvariantsFlag();
  if (!isRunnerActive(flag)) return { skipped: true, reason: 'flag_disabled' };
  const ctx = makeCtx({ db, dbFactory, paths, trigger: 'boot', logFallback: true });
  const report = await run({
    trigger: 'boot',
    ctx,
    statePath: paths.data.invariantsState(),
    lockDir: paths.data.invariantsLocks(),
  });
  return report;
}
