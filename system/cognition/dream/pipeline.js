import { surql } from 'surrealdb';
import { readCadenceConfig } from './budget.js';
import { DREAM_DAG_DEPS } from './dag.js';
import { readDreamConfig, shouldHalt } from './dream-budget.js';
import { runDag } from './scheduler.js';
import { dreamStepArcs } from './step-arcs.js';
import { dreamStepCalibration } from './step-calibration.js';
import { dreamStepCommStyle } from './step-comm-style.js';
import { dreamStepCompaction } from './step-compaction.js';
import { dreamStepKnowledge } from './step-knowledge.js';
import { dreamStepPatterns } from './step-patterns.js';
import { dreamStepProfile } from './step-profile.js';
import { dreamStepReflection } from './step-reflection.js';
import { byName as stepRegistry } from './step-registry.js';
import { dreamStepScopeCleanup } from './step-scope-cleanup.js';
import { recordStepTelemetry } from './telemetry.js';

/**
 * Dream pipeline orchestrator. Spec §3.
 *
 * Branches on `runtime:`dream.config`.value.parallelism_enabled`:
 *
 *   • false (default) → runDreamSerial: identical to today's pipeline.
 *     Serial source-order; ten try/catch blocks; verbatim from alpha.17.
 *   • true            → runDreamParallel: layered DAG via runDag.
 *
 * In both branches:
 *
 *   1. Every step has a chance to read events WHERE dreamed_at IS NONE.
 *   2. After every step settles, mark every undreamed event as dreamed (one
 *      UPDATE). Re-running observes an empty un-dreamed set and is naturally
 *      idempotent.
 *   3. Upsert runtime:dream with last_run_at / last_run_at_success / (in
 *      parallel mode) last_layers / last_halted.
 */
export async function dreamProcess(db, host, embedder, opts = {}) {
  const cfg = await readDreamConfig(db);
  if (!cfg.parallelism_enabled) {
    return await runDreamSerial(db, host, embedder, opts);
  }
  return await runDreamParallel(db, host, embedder, opts, cfg);
}

async function runDreamParallel(db, host, embedder, opts, cfg) {
  const cadenceCfg = await readCadenceConfig(db);
  const ctx = { db, host, embedder, opts };
  let summary = {};
  let layers = [];
  let halted = null;
  let schedulerError = null;
  try {
    ({ summary, layers, halted } = await runDag(stepRegistry, DREAM_DAG_DEPS, {
      ctx,
      maxConcurrent: cfg.max_concurrent ?? Infinity,
      shouldHalt: () => shouldHalt(db, cfg, cadenceCfg),
      onStepSettled: (name, ms, err) => {
        // recordStepTelemetry swallows internally; defence-in-depth.
        recordStepTelemetry(db, name, ms, err, { parallel: true }).catch(() => {});
      },
    }));
  } catch (e) {
    // runDag's per-step try/catch normally guarantees we never get here.
    // Defence-in-depth: skip the mark so a re-run can try again on the same
    // un-dreamed set (§7).
    schedulerError = e;
    console.warn(`[dream] scheduler threw uncaught: ${e.message} — skipping dreamed_at mark`);
  }

  if (!schedulerError) {
    await db
      .query(surql`UPDATE events SET dreamed_at = time::now() WHERE dreamed_at IS NONE`)
      .collect();
  }

  const success = !halted && !schedulerError;
  const layersForRow = layers.map((l) => ({ names: l.names, duration_ms: l.duration_ms }));
  if (success) {
    await db
      .query(
        surql`UPSERT type::record('runtime', 'dream')
              SET value.last_run_at = time::now(),
                  value.last_run_at_success = time::now(),
                  value.last_layers = ${layersForRow},
                  value.last_halted = NONE`,
      )
      .collect();
  } else {
    await db
      .query(
        surql`UPSERT type::record('runtime', 'dream')
              SET value.last_run_at = time::now(),
                  value.last_layers = ${layersForRow},
                  value.last_halted = ${halted ?? 'scheduler_error'}`,
      )
      .collect();
  }

  // Additive _meta key — parallel-mode only. normalizeSummary in §10.2 #12
  // strips this before equivalence comparison.
  summary._meta = {
    layers,
    halted,
    mode: 'parallel',
    scheduler_error: schedulerError?.message ?? null,
  };
  return summary;
}

// runDreamSerial — verbatim port of alpha.17 dreamProcess body. Kept
// byte-equivalent so flag-off behaviour is identical to the pre-C2 pipeline.
// When C2 graduates and the serial branch is retired, this function is the
// thing to delete; the call site in dreamProcess collapses to the parallel
// branch unconditionally. See spec §9.2 step 6.
async function runDreamSerial(db, host, embedder, opts = {}) {
  const summary = {};
  try {
    summary.knowledge = await dreamStepKnowledge(db, host, embedder, opts.knowledge);
  } catch (e) {
    summary.knowledge = { error: e.message };
  }
  try {
    summary.patterns = await dreamStepPatterns(db, host);
  } catch (e) {
    summary.patterns = { error: e.message };
  }
  try {
    summary.reflection = await dreamStepReflection(db, host, opts.reflection);
  } catch (e) {
    summary.reflection = { error: e.message };
  }
  try {
    summary.profile = await dreamStepProfile(db, host, opts.profile);
  } catch (e) {
    summary.profile = { error: e.message };
  }
  try {
    summary.arcs = await dreamStepArcs(db, opts.arcs);
  } catch (e) {
    summary.arcs = { error: e.message };
  }
  try {
    summary.commStyle = await dreamStepCommStyle(db, host);
  } catch (e) {
    summary.commStyle = { error: e.message };
  }
  try {
    summary.calibration = await dreamStepCalibration(db);
  } catch (e) {
    summary.calibration = { error: e.message };
  }
  try {
    summary.scopeCleanup = await dreamStepScopeCleanup(db, host, opts.scopeCleanup);
  } catch (e) {
    summary.scopeCleanup = { error: e.message };
  }
  try {
    summary.compaction = await dreamStepCompaction(db);
  } catch (e) {
    summary.compaction = { error: e.message };
  }

  await db
    .query(surql`UPDATE events SET dreamed_at = time::now() WHERE dreamed_at IS NONE`)
    .collect();

  await db
    .query(
      surql`UPSERT type::record('runtime', 'dream')
            SET value.last_run_at = time::now(),
                value.last_run_at_success = time::now()`,
    )
    .collect();

  return summary;
}
