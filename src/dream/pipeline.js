import { surql } from 'surrealdb';
import { dreamStepCalibration } from './step-calibration.js';
import { dreamStepCommStyle } from './step-comm-style.js';
import { dreamStepKnowledge } from './step-knowledge.js';
import { dreamStepPatterns } from './step-patterns.js';
import { dreamStepProfile } from './step-profile.js';
import { dreamStepReflection } from './step-reflection.js';
import { dreamStepScopeCleanup } from './step-scope-cleanup.js';
import { dreamStepThreads } from './step-threads.js';

/**
 * Dream pipeline orchestrator.
 *
 * Runs each step in sequence under independent try/catch blocks so a
 * single failing step does not abort the others. Errors land in
 * `summary.<step>.error`. After all steps complete, the pipeline:
 *
 * 1. Marks every event with `dreamed_at IS NONE` as dreamed (one batched
 *    UPDATE). Re-running the pipeline therefore observes an empty
 *    un-dreamed set and is naturally idempotent.
 * 2. Upserts `runtime:dream` with `last_run_at` and `last_run_at_success`
 *    for the daemon scheduler in Task 7.
 */
export async function dreamProcess(db, host, embedder, opts = {}) {
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
    summary.threads = await dreamStepThreads(db, opts.threads);
  } catch (e) {
    summary.threads = { error: e.message };
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
